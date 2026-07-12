/**
 * ============================================================================
 *  LAST VOYAGE — Devvit Web server
 * ============================================================================
 *  Express-style backend running on Reddit's Devvit Web runtime (@devvit/web).
 *
 *  Routes (all called from the canvas client via fetch()):
 *    GET  /api/init            -> everything the client needs to boot: today's
 *                                 board, username, streak, personal best,
 *                                 played-today flag, and today's leaderboard
 *    GET  /api/getDailyBoard   -> just the deterministic daily board
 *    POST /api/submitRun       -> record a run (once per user per day), update
 *                                 streak / personal best / daily leaderboard /
 *                                 subreddit faction total
 *    POST /internal/menu/create-post -> moderator menu action to spawn a post
 *
 *  Retention design (the "hook"):
 *    • The board is seeded by the UTC date — everyone sails the SAME ship each
 *      day, so scores are comparable and tomorrow is always a fresh race.
 *    • One scored run per day makes the attempt precious (wordle-style).
 *    • Streaks reward consecutive-day play; leaderboards reward mastery;
 *      faction totals give your whole subreddit a shared goal.
 * ============================================================================
 */

import express from 'express';
import {
  context,
  createServer,
  getServerPort,
  reddit,
  redis,
} from '@devvit/web/server';

// ---------------------------------------------------------------------------
// Board vocabulary — mirrored by hand in src/client/app.ts.
// ---------------------------------------------------------------------------
export type TileKind =
  | 'empty' // open, walkable deck
  | 'pearl' // +points; particle burst on pickup
  | 'crate' // supply crate: bigger bonus
  | 'shark' // hazard: costs HP (unless Harpoon)
  | 'breach' // hull breach / whirlpool: costs HP
  | 'lifeboat'; // the goal at [7,7]

export interface DailyBoard {
  date: string; // YYYY-MM-DD (UTC) — the seed
  size: number; // always 8
  grid: TileKind[][]; // grid[row][col]
}

const BOARD_SIZE = 8;
const START: readonly [number, number] = [0, 0];
const LIFEBOAT: readonly [number, number] = [7, 7];

// Daily entity counts (spec: 10 collectibles, 2 chests, 5 monsters, 3 traps).
const SPAWN_COUNTS = { pearl: 10, crate: 2, shark: 5, breach: 3 } as const;

// The lifeboat is 14 orthogonal moves from spawn (Manhattan [0,0]→[7,7]).
// The move budget is simulation-tuned (see README): 18 gives ~4 moves of
// slack — enough to detour for 2-3 treasures, never enough to loot the whole
// deck. Kept in sync with the client by hand.
const BASE_MAX_STEPS = 18;

// Hard ceiling on a legitimate score, used to clamp tampered submissions:
// 10 pearls×2 (compass) + 2 crates×50 + 5 sharks×25 (harpoon) + 100 lifeboat
// + 8 leftover moves×5 ≈ 565. Round up generously.
const MAX_PLAUSIBLE_SCORE = 1000;

// ---------------------------------------------------------------------------
// Redis key helpers. Everything is namespaced under "lv:".
// ---------------------------------------------------------------------------
const keys = {
  /** "played today" dedupe flag, one per user per day */
  played: (date: string, userId: string) => `lv:played:${date}:${userId}`,
  /** per-day leaderboard (sorted set: member = username, score = run score) */
  daily: (date: string) => `lv:lb:${date}`,
  /** global cross-subreddit faction totals (sorted set: member = subreddit) */
  factions: 'lv:factions',
  /** per-user personal best (string int) */
  best: (userId: string) => `lv:best:${userId}`,
  /** per-user streak state (JSON: { count, last }) */
  streak: (userId: string) => `lv:streak:${userId}`,
} as const;

// ---------------------------------------------------------------------------
// Deterministic RNG: hash the date string to a 32-bit seed, feed mulberry32.
// Same date => same board for every player => a fair daily race.
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

/** Today's UTC date as YYYY-MM-DD — the daily seed. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Yesterday's UTC date as YYYY-MM-DD — used for streak continuity. */
function yesterdayKey(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * True if a hazard-free path exists from START to LIFEBOAT within the move
 * budget. Plain BFS over the 4-connected grid, skipping sharks and breaches.
 * (Players CAN tank hazards with HP, so this is a conservative check — if a
 * clean path exists the board is comfortably winnable.)
 */
function isWinnable(grid: TileKind[][]): boolean {
  const blocked = (t: TileKind): boolean => t === 'shark' || t === 'breach';
  const dist: number[][] = grid.map((row) => row.map(() => -1));
  dist[START[0]][START[1]] = 0;
  const queue: Array<[number, number]> = [[START[0], START[1]]];
  while (queue.length > 0) {
    const [r, c] = queue.shift()!;
    if (r === LIFEBOAT[0] && c === LIFEBOAT[1]) return dist[r][c] <= BASE_MAX_STEPS;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
      if (dist[nr][nc] !== -1 || blocked(grid[nr][nc])) continue;
      dist[nr][nc] = dist[r][c] + 1;
      queue.push([nr, nc]);
    }
  }
  return false;
}

/**
 * The deterministic board for a date, GUARANTEED winnable: generate from the
 * date seed, and if the layout walls off the lifeboat, deterministically
 * re-roll with "date#1", "date#2", … — still identical for every player.
 */
function generateDailyBoard(date: string): DailyBoard {
  for (let attempt = 0; attempt < 100; attempt++) {
    const seed = attempt === 0 ? date : `${date}#${attempt}`;
    const board = generateBoardFromSeed(date, seed);
    if (isWinnable(board.grid)) return board;
  }
  // Statistically unreachable (8 hazards on 64 tiles almost never wall off a
  // 20-step path 100 times in a row), but never leave the player boardless.
  return generateBoardFromSeed(date, date);
}

/**
 * Build one board candidate: start empty, reserve spawn + lifeboat,
 * seed-shuffle the remaining 62 cells (Fisher–Yates), then deal entities off
 * the top of the shuffled deck in a fixed order.
 */
function generateBoardFromSeed(date: string, seed: string): DailyBoard {
  const rand = mulberry32(hashStringToSeed(seed));

  const grid: TileKind[][] = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => 'empty' as TileKind)
  );

  const cells: Array<[number, number]> = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const isStart = r === START[0] && c === START[1];
      const isLifeboat = r === LIFEBOAT[0] && c === LIFEBOAT[1];
      if (!isStart && !isLifeboat) cells.push([r, c]);
    }
  }

  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  let cursor = 0;
  const deal = (tile: TileKind, count: number): void => {
    for (let n = 0; n < count; n++) {
      const [r, c] = cells[cursor++];
      grid[r][c] = tile;
    }
  };
  deal('pearl', SPAWN_COUNTS.pearl);
  deal('crate', SPAWN_COUNTS.crate);
  deal('shark', SPAWN_COUNTS.shark);
  deal('breach', SPAWN_COUNTS.breach);

  grid[LIFEBOAT[0]][LIFEBOAT[1]] = 'lifeboat';

  return { date, size: BOARD_SIZE, grid };
}

// ---------------------------------------------------------------------------
// Small data helpers shared by /api/init and /api/submitRun.
// ---------------------------------------------------------------------------
interface StreakState {
  count: number;
  last: string; // YYYY-MM-DD of the last scored run
}

async function readStreak(userId: string): Promise<StreakState> {
  const raw = await redis.get(keys.streak(userId));
  if (!raw) return { count: 0, last: '' };
  try {
    const parsed = JSON.parse(raw) as StreakState;
    return { count: parsed.count ?? 0, last: parsed.last ?? '' };
  } catch {
    return { count: 0, last: '' };
  }
}

/**
 * The streak a user SHOULD see right now: full credit if they already played
 * today or yesterday (streak alive), otherwise it has lapsed back to 0.
 */
function effectiveStreak(s: StreakState, today: string, yesterday: string): number {
  return s.last === today || s.last === yesterday ? s.count : 0;
}

/** Top-N of today's leaderboard, highest first. */
async function readDailyTop(
  date: string,
  n: number
): Promise<Array<{ member: string; score: number }>> {
  return await redis.zRange(keys.daily(date), 0, n - 1, {
    by: 'rank',
    reverse: true,
  });
}

// ===========================================================================
//  Express app
// ===========================================================================
const app = express();
app.use(express.json());

const router = express.Router();

/**
 * GET /api/init
 * One round trip that boots the whole client: today's board plus everything
 * needed to render the title screen (streak, best, played-today, leaderboard).
 */
router.get('/api/init', async (_req, res) => {
  try {
    const date = todayKey();
    const userId = context.userId ?? 'anon';

    // Fetch the username for the HUD/leaderboard; tolerate logged-out users.
    let username: string | undefined;
    try {
      username = await reddit.getCurrentUsername();
    } catch {
      username = undefined;
    }

    const [playedRaw, bestRaw, streakState, dailyTop] = await Promise.all([
      redis.get(keys.played(date, userId)),
      redis.get(keys.best(userId)),
      readStreak(userId),
      readDailyTop(date, 10),
    ]);

    res.json({
      board: generateDailyBoard(date),
      username: username ?? 'sailor',
      playedToday: Boolean(playedRaw),
      todayScore: playedRaw ? Number(playedRaw) : null,
      personalBest: Number(bestRaw ?? 0),
      streak: effectiveStreak(streakState, date, yesterdayKey()),
      leaderboard: dailyTop,
      subreddit: context.subredditName ?? 'unknown',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: String(err) });
  }
});

/**
 * GET /api/getDailyBoard
 * Pure function of the date — same 8×8 layout for every player today.
 */
router.get('/api/getDailyBoard', (_req, res) => {
  res.json(generateDailyBoard(todayKey()));
});

/**
 * POST /api/submitRun
 * Body: { score: number }
 *
 * Records a finished run. Enforces ONE scored run per user per day via a Redis
 * flag; on success updates the daily streak, personal best, today's
 * leaderboard, and the subreddit faction total — and returns all of them so
 * the client can paint the game-over screen from a single response.
 */
router.post('/api/submitRun', async (req, res) => {
  try {
    const date = todayKey();
    const userId = context.userId ?? 'anon';
    const subreddit = context.subredditName ?? 'unknown';

    // Clamp the score so a tampered client can't inject nonsense.
    const rawScore = Number((req.body ?? {}).score);
    const score = Number.isFinite(rawScore)
      ? Math.max(0, Math.min(MAX_PLAUSIBLE_SCORE, Math.floor(rawScore)))
      : 0;

    // --- One scored run per user per day --------------------------------
    const playedKey = keys.played(date, userId);
    const already = await redis.get(playedKey);
    if (already) {
      res.status(409).json({
        ok: false,
        reason: 'already_submitted',
        message: 'Today’s voyage is already logged — practice runs don’t count. New ship at midnight UTC!',
      });
      return;
    }
    // Flag expires ~48h out so old keys clean themselves up.
    await redis.set(playedKey, String(score), {
      expiration: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });

    // --- Streak ----------------------------------------------------------
    const prev = await readStreak(userId);
    const streak = prev.last === yesterdayKey() ? prev.count + 1 : 1;
    await redis.set(keys.streak(userId), JSON.stringify({ count: streak, last: date }));

    // --- Personal best ---------------------------------------------------
    const prevBest = Number((await redis.get(keys.best(userId))) ?? 0);
    const personalBest = Math.max(prevBest, score);
    if (personalBest !== prevBest) {
      await redis.set(keys.best(userId), String(personalBest));
    }

    // --- Today's leaderboard (member = username so it's human-readable) --
    let username: string | undefined;
    try {
      username = await reddit.getCurrentUsername();
    } catch {
      username = undefined;
    }
    const member = username ?? `sailor-${userId.slice(-6)}`;
    const dailyKey = keys.daily(date);
    await redis.zAdd(dailyKey, { member, score });
    await redis.expire(dailyKey, 48 * 60 * 60); // self-clean after 2 days

    // --- Faction (subreddit) total ---------------------------------------
    const factionTotal = await redis.zIncrBy(keys.factions, subreddit, score);

    res.json({
      ok: true,
      score,
      personalBest,
      isNewBest: score > prevBest,
      streak,
      faction: subreddit,
      factionTotal,
      leaderboard: await readDailyTop(date, 10),
      you: member,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: String(err) });
  }
});

/**
 * POST /internal/menu/create-post
 * Moderator menu action (declared in devvit.json) — spawns a game post.
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
      title: '🌊 Last Voyage — the ship sinks today. Can you reach the lifeboat?',
      textFallback: {
        text: 'Last Voyage is an interactive daily escape game. Open this post on new Reddit or the app to play!',
      },
    });

    res.json({
      showToast: 'Voyage launched! 🚢',
      navigateTo: `https://reddit.com${post.permalink}`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: String(err) });
  }
});

app.use(router);

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
const port = getServerPort();
const server = createServer(app);
server.listen(port, () => {
  console.log(`[last-voyage] listening on :${port}`);
});
