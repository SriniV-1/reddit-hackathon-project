/**
 * Local playtest server — play Last Voyage WITHOUT the Devvit runtime.
 *
 * Serves the built client (dist/client) and mocks the /api endpoints with the
 * exact same seeded board-generation code as the real server, plus an
 * in-memory stand-in for Redis (streak / best / leaderboard / dedupe).
 *
 * Usage:
 *   npm run build:client
 *   node scripts/local-playtest.mjs
 *   → open http://localhost:7373
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'client');
const PORT = 7373;

// --- board generation (mirrors src/server/index.ts) ------------------------
function hashStringToSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const BASE_MAX_STEPS = 18;

export function isWinnable(grid) {
  const SIZE = 8;
  const blocked = (t) => t === 'shark' || t === 'breach';
  const dist = grid.map((row) => row.map(() => -1));
  dist[0][0] = 0;
  const queue = [[0, 0]];
  while (queue.length > 0) {
    const [r, c] = queue.shift();
    if (r === 7 && c === 7) return dist[r][c] <= BASE_MAX_STEPS;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
      if (dist[nr][nc] !== -1 || blocked(grid[nr][nc])) continue;
      dist[nr][nc] = dist[r][c] + 1;
      queue.push([nr, nc]);
    }
  }
  return false;
}

function generateBoardFromSeed(date, seed) {
  const rand = mulberry32(hashStringToSeed(seed));
  const SIZE = 8;
  const grid = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 'empty'));
  const cells = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (!(r === 0 && c === 0) && !(r === 7 && c === 7)) cells.push([r, c]);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  let cursor = 0;
  const deal = (tile, count) => {
    for (let n = 0; n < count; n++) {
      const [r, c] = cells[cursor++];
      grid[r][c] = tile;
    }
  };
  deal('pearl', 10);
  deal('crate', 2);
  deal('shark', 5);
  deal('breach', 3);
  grid[7][7] = 'lifeboat';
  return { date, size: SIZE, grid };
}

export function generateDailyBoard(date) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const seed = attempt === 0 ? date : `${date}#${attempt}`;
    const board = generateBoardFromSeed(date, seed);
    if (isWinnable(board.grid)) return board;
  }
  return generateBoardFromSeed(date, date);
}

// --- in-memory "Redis" ------------------------------------------------------
let playedToday = false;
let todayScore = null;
let best = 120;
let streak = 3;
const leaderboard = [
  { member: 'pearl_diver_99', score: 285 },
  { member: 'captain_kraken', score: 240 },
  { member: 'soggy_socks', score: 145 },
];

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const today = new Date().toISOString().slice(0, 10);

  if (url.pathname === '/api/init') {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        board: generateDailyBoard(today),
        username: 'local_tester',
        playedToday,
        todayScore,
        personalBest: best,
        streak,
        leaderboard: [...leaderboard].sort((a, b) => b.score - a.score),
        subreddit: 'LastVoyageGame',
      })
    );
    return;
  }
  if (url.pathname === '/api/getDailyBoard') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(generateDailyBoard(today)));
    return;
  }
  if (url.pathname === '/api/submitRun' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (playedToday) {
        res.statusCode = 409;
        res.end(
          JSON.stringify({
            ok: false,
            reason: 'already_submitted',
            message:
              'Today’s voyage is already logged — practice runs don’t count. New ship at midnight UTC!',
          })
        );
        return;
      }
      const score = Math.max(
        0,
        Math.min(1000, Math.floor(Number(JSON.parse(body || '{}').score) || 0))
      );
      playedToday = true;
      todayScore = score;
      const isNewBest = score > best;
      best = Math.max(best, score);
      streak += 1;
      leaderboard.push({ member: 'local_tester', score });
      leaderboard.sort((a, b) => b.score - a.score);
      res.end(
        JSON.stringify({
          ok: true,
          score,
          personalBest: best,
          isNewBest,
          streak,
          faction: 'LastVoyageGame',
          factionTotal: 4235 + score,
          leaderboard: leaderboard.slice(0, 10),
          you: 'local_tester',
        })
      );
    });
    return;
  }

  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const data = await readFile(join(CLIENT_DIR, path));
    res.setHeader('content-type', MIME[extname(path)] ?? 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('not found — did you run `npm run build:client` first?');
  }
});

// Only start listening when run directly (`node scripts/local-playtest.mjs`),
// so tests can import generateDailyBoard/isWinnable without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () =>
    console.log(`⚓ Last Voyage local playtest → http://localhost:${PORT}`)
  );
}
