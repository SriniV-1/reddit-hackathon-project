/**
 * ============================================================================
 *  LAST VOYAGE — Devvit Web server
 * ============================================================================
 *  A tiny Express-style backend that runs on Reddit's Devvit Web runtime.
 *
 *  It exposes three routes the canvas client talks to over `fetch()`:
 *    GET  /api/getDailyBoard      -> deterministic daily 8x8 board (same for
 *                                    everyone on a given calendar day)
 *    POST /api/submitRun          -> record a finished run once per user/day and
 *                                    add the score to the subreddit's "faction"
 *    POST /internal/menu/create-post -> moderator menu action to spawn a post
 *
 *  Everything the game "looks like" (ship, water, pearls, sharks) is drawn on
 *  the client. The server only deals in data.
 * ============================================================================
 */

import express from 'express';
// The Devvit runtime injects these. Depending on your @devvit/web version the
// same symbols may live at '@devvit/server' / '@devvit/redis' / '@devvit/reddit'
// — consolidate the import line if your CLI complains.
import {
  createServer,
  getServerPort,
  context,
  redis,
  reddit,
} from '@devvit/web/server';

// ---------------------------------------------------------------------------
// Shared board vocabulary. Kept in sync (by hand) with the client's copy so the
// two independent bundles agree on what each tile means.
// ---------------------------------------------------------------------------
export type Tile =
  | 'empty' // open, walkable deck
  | 'pearl' // +points, spawns a particle burst on the client
  | 'crate' // supply crate: bigger points bonus
  | 'shark' // hazard: costs HP
  | 'breach' // hull breach / whirlpool: costs HP
  | 'lifeboat'; // the goal at [7,7]

export interface DailyBoard {
  date: string; // YYYY-MM-DD (the seed)
  size: number; // always 8
  grid: Tile[][]; // grid[row][col]
}

const BOARD_SIZE = 8;
const START: readonly [number, number] = [0, 0]; // player spawn (row, col)
const LIFEBOAT: readonly [number, number] = [7, 7]; // the exit

// How many of each entity to scatter across the deck each day.
const SPAWN_COUNTS = {
  pearl: 10,
  crate: 2,
  shark: 5,
  breach: 3,
} as const;

// ---------------------------------------------------------------------------
// Deterministic RNG. We hash the date string into a 32-bit seed and feed it to
// mulberry32 — a tiny, fast, well-distributed PRNG. Same date => same board for
// every player, which is what makes the daily leaderboard fair.
// ---------------------------------------------------------------------------
function hashStringToSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Today's date in UTC as YYYY-MM-DD — the daily seed. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the deterministic board for a given date.
 *
 * Strategy: start with an all-empty grid, reserve the spawn + lifeboat tiles,
 * then seed-shuffle every remaining coordinate and deal entities off the top of
 * the deck. Because the shuffle is deterministic, the layout is identical for
 * everyone playing on `date`.
 */
function generateDailyBoard(date: string): DailyBoard {
  const rand = mulberry32(hashStringToSeed(date));

  // 1. Empty deck.
  const grid: Tile[][] = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => 'empty' as Tile)
  );

  // 2. Collect every placeable cell except the reserved start + lifeboat.
  const cells: Array<[number, number]> = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const isStart = r === START[0] && c === START[1];
      const isLifeboat = r === LIFEBOAT[0] && c === LIFEBOAT[1];
      if (!isStart && !isLifeboat) cells.push([r, c]);
    }
  }

  // 3. Fisher–Yates shuffle driven by the seeded RNG.
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  // 4. Deal entities off the shuffled deck in a fixed order.
  let cursor = 0;
  const deal = (tile: Tile, count: number) => {
    for (let n = 0; n < count; n++) {
      const [r, c] = cells[cursor++];
      grid[r][c] = tile;
    }
  };
  deal('pearl', SPAWN_COUNTS.pearl);
  deal('crate', SPAWN_COUNTS.crate);
  deal('shark', SPAWN_COUNTS.shark);
  deal('breach', SPAWN_COUNTS.breach);

  // 5. Plant the lifeboat at the exit.
  grid[LIFEBOAT[0]][LIFEBOAT[1]] = 'lifeboat';

  return { date, size: BOARD_SIZE, grid };
}

// ===========================================================================
//  Express app
// ===========================================================================
const app = express();
app.use(express.json());

const router = express.Router();

/**
 * GET /api/getDailyBoard
 * Returns today's deterministic board. Safe to call as often as you like — it's
 * a pure function of the date, so there's nothing to persist here.
 */
router.get('/api/getDailyBoard', (_req, res) => {
  const board = generateDailyBoard(todayKey());
  res.json(board);
});

/**
 * POST /api/submitRun
 * Body: { score: number }
 *
 * Records a finished run. Guarantees ONE submission per user per day via a
 * Redis flag, then adds the score to the player's subreddit "faction" total
 * (a sorted set we can later render as a cross-subreddit leaderboard).
 */
router.post('/api/submitRun', async (req, res) => {
  const date = todayKey();
  const userId = context.userId ?? 'anon';
  const subreddit = context.subredditName ?? 'unknown';

  // Validate + clamp the incoming score so a tampered client can't inject junk.
  const rawScore = Number((req.body ?? {}).score);
  const score = Number.isFinite(rawScore)
    ? Math.max(0, Math.min(9999, Math.floor(rawScore)))
    : 0;

  // --- One run per user per day -------------------------------------------
  const dedupeKey = `sink:submitted:${date}:${userId}`;
  const already = await redis.get(dedupeKey);
  if (already) {
    res.status(409).json({
      ok: false,
      reason: 'already_submitted',
      message: 'You have already logged a voyage today. Come back tomorrow!',
    });
    return;
  }

  // Set the flag, and expire it ~36h out so tomorrow's key starts fresh.
  await redis.set(dedupeKey, String(score), {
    expiration: new Date(Date.now() + 36 * 60 * 60 * 1000),
  });

  // --- Faction (subreddit) scoreboard -------------------------------------
  // zIncrBy bumps this subreddit's cumulative score in a global sorted set.
  const factionKey = 'sink:factions';
  const factionTotal = await redis.zIncrBy(factionKey, subreddit, score);

  // Also keep a lightweight personal-best for this user (nice for the UI).
  const bestKey = `sink:best:${userId}`;
  const prevBest = Number((await redis.get(bestKey)) ?? 0);
  const personalBest = Math.max(prevBest, score);
  if (personalBest !== prevBest) {
    await redis.set(bestKey, String(personalBest));
  }

  res.json({
    ok: true,
    score,
    personalBest,
    faction: subreddit,
    factionTotal,
  });
});

/**
 * POST /internal/menu/create-post
 * Backing endpoint for the subreddit moderator menu item declared in
 * devvit.json. Spawns a fresh Last Voyage post in the current subreddit.
 *
 * NOTE: the exact "create an app post" call has shifted across Devvit versions
 * (submitCustomPost / submitPost + splash). This uses the current form; adjust
 * the call if your installed CLI exposes a different signature.
 */
router.post('/internal/menu/create-post', async (_req, res) => {
  try {
    const subredditName = context.subredditName;
    if (!subredditName) {
      res.status(400).json({ ok: false, message: 'No subreddit in context.' });
      return;
    }

    const post = await reddit.submitCustomPost({
      subredditName,
      title: '🌊 Last Voyage — escape today’s sinking ship!',
      splash: {
        appDisplayName: 'Last Voyage',
        description: 'Grab the pearls. Dodge the sharks. Reach the lifeboat.',
      },
    });

    res.json({ ok: true, postId: post.id });
  } catch (err) {
    res.status(500).json({
      ok: false,
      message: 'Failed to create post.',
      error: String(err),
    });
  }
});

app.use(router);

// ---------------------------------------------------------------------------
// Boot. Devvit provides the port via getServerPort(); createServer wires our
// Express app into the runtime's request lifecycle.
// ---------------------------------------------------------------------------
const port = getServerPort();
const server = createServer(app);
server.listen(port, () => {
  console.log(`[last-voyage] server listening on :${port}`);
});
