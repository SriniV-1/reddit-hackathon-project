/**
 * ============================================================================
 *  LAST VOYAGE — Devvit Web client (100% HTML5 Canvas, zero image assets)
 * ============================================================================
 *  The ship is going down. You start at the stern [0,0] with 3 HP and 18
 *  moves. Grab pearls, crack open supply crates, dodge sharks and hull
 *  breaches, and reach the lifeboat at [7,7] — and don't dawdle: the sea
 *  floods the deck row by row in REAL TIME, from the stern toward the bow.
 *
 *  Rendering: a 2.5D "GBA overworld" look built purely from canvas
 *  primitives — beveled tiles, drop shadows, entities that stand on their
 *  tiles and overlap the row behind them (painter's order), a walking player
 *  character, and volumetric flood water with foam and caustic shimmer.
 *  Sound is synthesized live with WebAudio. No image or audio files exist.
 *
 *  Movement lerps over ~150ms with smoothstep (never snaps). Damage shakes
 *  the screen. Pearls burst into expanding rings.
 *
 *  State machine:  loading → title → relic → playing → gameover
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Shared vocabulary — mirrors src/server/index.ts (kept in sync by hand).
// ---------------------------------------------------------------------------
type TileKind = 'empty' | 'pearl' | 'crate' | 'shark' | 'breach' | 'lifeboat';

interface DailyBoard {
  date: string;
  size: number;
  grid: TileKind[][]; // grid[row][col]
}

interface LeaderboardRow {
  member: string;
  score: number;
}

interface InitData {
  board: DailyBoard;
  username: string;
  playedToday: boolean;
  todayScore: number | null;
  personalBest: number;
  streak: number;
  leaderboard: LeaderboardRow[];
  subreddit: string;
}

interface SubmitData {
  ok: boolean;
  score: number;
  personalBest: number;
  isNewBest: boolean;
  streak: number;
  faction: string;
  factionTotal: number;
  leaderboard: LeaderboardRow[];
  you: string;
  message?: string;
}

type Phase = 'loading' | 'title' | 'relic' | 'playing' | 'gameover';
type Ending = 'escaped' | 'drowned' | 'stranded' | null;

type RelicId = 'seaLegs' | 'compass' | 'harpoon';
interface Relic {
  id: RelicId;
  name: string;
  blurb: string;
  emoji: string;
}

interface Hitbox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Tunables. Difficulty numbers are simulation-backed (see README): 18 moves
// gives ~4 moves of slack over the 14-move sprint — enough to detour for 2-3
// treasures with sharp routing, never enough to loot the whole deck.
// ---------------------------------------------------------------------------
const BOARD_SIZE = 8;
const BASE_MAX_STEPS = 18;
const SEA_LEGS_BONUS = 4;
const START_HP = 3;
const MOVE_MS = 150; // lerp duration between tiles

// Real-time flood: after FLOOD_GRACE_S seconds the stern row (row 0) goes
// under, then one more row every FLOOD_ROW_S seconds. Wading costs HP.
const FLOOD_GRACE_S = 20;
const FLOOD_ROW_S = 8;

const POINTS = {
  pearl: 10,
  crate: 50,
  harpoonKill: 25,
  lifeboat: 100,
  perLeftoverStep: 5,
} as const;

const RELICS: Relic[] = [
  { id: 'seaLegs', name: 'Sea Legs', blurb: `+${SEA_LEGS_BONUS} extra moves`, emoji: '🥾' },
  { id: 'compass', name: "Navigator's Compass", blurb: 'Pearls worth ×2', emoji: '🧭' },
  { id: 'harpoon', name: 'Harpoon', blurb: 'Sharks give +25, deal no damage', emoji: '🔱' },
];

const COLORS = {
  deckLight: '#c9a26b',
  deckDark: '#bd9560',
  deckSeam: 'rgba(91, 68, 38, 0.55)',
  railWood: '#7a5a33',
  railWoodDark: '#5b4426',
  hullSide: '#3c2d18',
  pearl: '#eafcff',
  pearlCore: '#9fe8ff',
  crateTop: '#c08a3e',
  crateFront: '#9a6c28',
  crateBand: '#5e3d15',
  shark: '#6b7f8c',
  sharkBelly: '#c3d0d8',
  breach: '#0a2233',
  breachFoam: '#7fd4ff',
  lifeboat: '#ff6b3d',
  lifeboatDark: '#c94e28',
  lifeboatTrim: '#ffe8d6',
  skin: '#f2c99a',
  vest: '#ff9d2e',
  shirt: '#2fa8ff',
  pants: '#28527a',
  hud: '#e9f6ff',
  hudDim: 'rgba(233, 246, 255, 0.65)',
  panel: 'rgba(3, 20, 33, 0.85)',
  gold: '#ffd23f',
  danger: '#ff6161',
  shipDark: '#101c26',
  shadow: 'rgba(10, 20, 30, 0.30)',
} as const;

// ---------------------------------------------------------------------------
// Canvas + layout. The board is inset from the edges so a wooden railing can
// frame the deck (part of the 2.5D look). Portrait: [HUD | railed board | sea].
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let VIEW_W = 0;
let VIEW_H = 0;
let HUD_H = 0;
let BOARD_PX = 0; // side length of the 8×8 play area
let TILE = 0;
let BOARD_X = 0; // left inset (railing margin)
let BOARD_Y = 0; // top of the play area
let RAIL = 0; // railing thickness

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.min(window.innerWidth, window.innerHeight / 1.28);
  VIEW_W = Math.floor(w);
  HUD_H = Math.floor(VIEW_W * 0.15);
  RAIL = Math.floor(VIEW_W * 0.035);
  BOARD_PX = VIEW_W - RAIL * 2;
  TILE = BOARD_PX / BOARD_SIZE;
  BOARD_X = RAIL;
  BOARD_Y = HUD_H + RAIL;
  const footer = Math.floor(VIEW_W * 0.1);
  VIEW_H = HUD_H + RAIL + BOARD_PX + RAIL + footer;

  canvas.style.width = `${VIEW_W}px`;
  canvas.style.height = `${VIEW_H}px`;
  canvas.width = Math.floor(VIEW_W * dpr);
  canvas.height = Math.floor(VIEW_H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/** Center of tile (r, c) in logical pixels. */
function tileCenter(r: number, c: number): { x: number; y: number } {
  return { x: BOARD_X + c * TILE + TILE / 2, y: BOARD_Y + r * TILE + TILE / 2 };
}

// ---------------------------------------------------------------------------
// WebAudio — synthesized on the fly; context unlocked on first gesture.
// ---------------------------------------------------------------------------
let audio: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

function ensureAudio(): void {
  try {
    if (!audio) {
      audio = new AudioContext();
      // One second of white noise, reused for splash/hurt textures.
      noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

function tone(
  freq: number,
  durMs: number,
  type: OscillatorType = 'sine',
  volume = 0.12,
  delayMs = 0,
  glideTo?: number
): void {
  if (!audio) return;
  const t0 = audio.currentTime + delayMs / 1000;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t0 + durMs / 1000);
  }
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(gain).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

/** A pitched noise burst (splashes, hits). */
function noise(durMs: number, volume = 0.1, delayMs = 0, lowpassHz = 1200): void {
  if (!audio || !noiseBuf) return;
  const t0 = audio.currentTime + delayMs / 1000;
  const src = audio.createBufferSource();
  src.buffer = noiseBuf;
  const filter = audio.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = lowpassHz;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  src.connect(filter).connect(gain).connect(audio.destination);
  src.start(t0);
  src.stop(t0 + durMs / 1000 + 0.02);
}

function sfx(
  name: 'move' | 'pearl' | 'crate' | 'hurt' | 'splash' | 'win' | 'lose' | 'ui'
): void {
  if (!audio) return;
  switch (name) {
    case 'move':
      tone(220, 70, 'triangle', 0.07, 0, 170);
      break;
    case 'pearl':
      tone(880, 90, 'sine', 0.1);
      tone(1318, 120, 'sine', 0.1, 70);
      break;
    case 'crate':
      tone(150, 90, 'square', 0.08);
      tone(988, 140, 'sine', 0.1, 80);
      tone(1318, 160, 'sine', 0.09, 150);
      break;
    case 'hurt':
      tone(140, 220, 'sawtooth', 0.14, 0, 55);
      noise(160, 0.08, 0, 900);
      break;
    case 'splash':
      noise(280, 0.12, 0, 700);
      tone(180, 160, 'sine', 0.06, 0, 90);
      break;
    case 'win':
      tone(523, 120, 'triangle', 0.12);
      tone(659, 120, 'triangle', 0.12, 110);
      tone(784, 200, 'triangle', 0.13, 220);
      tone(1046, 320, 'triangle', 0.12, 330);
      break;
    case 'lose':
      tone(330, 250, 'sawtooth', 0.09, 0, 220);
      tone(220, 420, 'sawtooth', 0.1, 200, 110);
      noise(500, 0.06, 150, 500);
      break;
    case 'ui':
      tone(660, 50, 'triangle', 0.06);
      break;
  }
}

// ---------------------------------------------------------------------------
// Game state.
// ---------------------------------------------------------------------------
interface Particle {
  x: number;
  y: number;
  born: number;
  life: number;
  hue: string;
}

interface MoveAnim {
  fromR: number;
  fromC: number;
  toR: number;
  toC: number;
  start: number;
}

const state = {
  phase: 'loading' as Phase,
  error: '',

  init: null as InitData | null,
  pristineGrid: null as TileKind[][] | null,
  grid: null as TileKind[][] | null,

  practice: false,

  playerR: 0,
  playerC: 0,
  facing: 1 as 1 | -1, // 1 = facing right, -1 = facing left
  move: null as MoveAnim | null,

  hp: START_HP,
  maxSteps: BASE_MAX_STEPS,
  stepsUsed: 0,
  score: 0,
  relic: null as RelicId | null,

  /** performance.now() when gameplay actually began (flood clock). */
  runStart: 0,
  /** Set at game over so the flood freezes on the final frame. */
  runEnd: null as number | null,
  /** Highest row index the flood has claimed damage for (event dedupe). */
  floodDamageRow: -1,

  ending: null as Ending,
  particles: [] as Particle[],
  shake: { mag: 0, until: 0 },

  submitState: 'idle' as 'idle' | 'sending' | 'done' | 'error',
  submit: null as SubmitData | null,
  submitMsg: '',

  hitboxes: [] as Hitbox[],
};

// ---------------------------------------------------------------------------
// Flood model. Water claims rows top-down (row 0 = stern first) in real time.
// `floodLevel` is a continuous row count: 0 → dry deck, 8 → fully submerged.
// ---------------------------------------------------------------------------
function floodLevel(now: number): number {
  if (state.phase !== 'playing' && state.phase !== 'gameover') return 0;
  const end = state.runEnd ?? now;
  const elapsed = (Math.min(now, end) - state.runStart) / 1000;
  if (elapsed <= FLOOD_GRACE_S) return 0;
  return Math.min(BOARD_SIZE, (elapsed - FLOOD_GRACE_S) / FLOOD_ROW_S);
}

/** A row is "flooded" once the waterline has passed most of the way over it. */
function isRowFlooded(row: number, now: number): boolean {
  return floodLevel(now) >= row + 0.6;
}

/** Seconds until `row` floods (Infinity if > 99s away). */
function secondsUntilFlood(row: number, now: number): number {
  const end = state.runEnd ?? now;
  const elapsed = (Math.min(now, end) - state.runStart) / 1000;
  const floodsAt = FLOOD_GRACE_S + (row + 0.6) * FLOOD_ROW_S;
  return Math.max(0, floodsAt - elapsed);
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
async function boot(): Promise<void> {
  try {
    const res = await fetch('/api/init');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: InitData = await res.json();
    state.init = data;
    state.pristineGrid = data.board.grid;
    state.phase = 'title';
  } catch (err) {
    state.error = `Couldn't reach the harbor (${String(err)}). Refresh to retry.`;
    state.phase = 'title';
  }
}
void boot();

function startRun(practice: boolean): void {
  if (!state.pristineGrid) return;
  state.practice = practice;
  state.grid = state.pristineGrid.map((row) => [...row]);
  state.playerR = 0;
  state.playerC = 0;
  state.facing = 1;
  state.move = null;
  state.hp = START_HP;
  state.maxSteps = BASE_MAX_STEPS;
  state.stepsUsed = 0;
  state.score = 0;
  state.relic = null;
  state.runStart = 0;
  state.runEnd = null;
  state.floodDamageRow = -1;
  state.ending = null;
  state.particles = [];
  state.submitState = 'idle';
  state.submit = null;
  state.submitMsg = '';
  state.phase = 'relic';
}

// ---------------------------------------------------------------------------
// Input.
// ---------------------------------------------------------------------------
function toLogical(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (VIEW_W / rect.width),
    y: (clientY - rect.top) * (VIEW_H / rect.height),
  };
}

function hitTest(x: number, y: number): string | null {
  for (const hb of state.hitboxes) {
    if (x >= hb.x && x <= hb.x + hb.w && y >= hb.y && y <= hb.y + hb.h) return hb.id;
  }
  return null;
}

function handlePointer(clientX: number, clientY: number): void {
  ensureAudio();
  const { x, y } = toLogical(clientX, clientY);
  const hit = hitTest(x, y);

  switch (state.phase) {
    case 'title': {
      if (hit === 'play') {
        sfx('ui');
        startRun(Boolean(state.init?.playedToday));
      }
      return;
    }
    case 'relic': {
      if (hit?.startsWith('relic:')) {
        sfx('ui');
        chooseRelic(hit.slice('relic:'.length) as RelicId);
      }
      return;
    }
    case 'playing': {
      if (state.move) return;
      const c = Math.floor((x - BOARD_X) / TILE);
      const r = Math.floor((y - BOARD_Y) / TILE);
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return;
      tryMove(r, c);
      return;
    }
    case 'gameover': {
      if (hit === 'again') {
        sfx('ui');
        startRun(true);
      }
      return;
    }
    default:
      return;
  }
}

function tryMove(r: number, c: number): void {
  const dr = Math.abs(r - state.playerR);
  const dc = Math.abs(c - state.playerC);
  if (dr + dc !== 1) return;
  if (c > state.playerC) state.facing = 1;
  if (c < state.playerC) state.facing = -1;
  sfx('move');
  state.move = {
    fromR: state.playerR,
    fromC: state.playerC,
    toR: r,
    toC: c,
    start: performance.now(),
  };
}

canvas.addEventListener('mousedown', (e) => handlePointer(e.clientX, e.clientY));
canvas.addEventListener(
  'touchstart',
  (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    if (t) handlePointer(t.clientX, t.clientY);
  },
  { passive: false }
);

window.addEventListener('keydown', (e) => {
  if (state.phase !== 'playing' || state.move) return;
  ensureAudio();
  const pr = Math.round(state.playerR);
  const pc = Math.round(state.playerC);
  const map: Record<string, [number, number]> = {
    ArrowUp: [pr - 1, pc],
    ArrowDown: [pr + 1, pc],
    ArrowLeft: [pr, pc - 1],
    ArrowRight: [pr, pc + 1],
    w: [pr - 1, pc],
    s: [pr + 1, pc],
    a: [pr, pc - 1],
    d: [pr, pc + 1],
  };
  const target = map[e.key];
  if (!target) return;
  const [r, c] = target;
  if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return;
  e.preventDefault();
  tryMove(r, c);
});

// ---------------------------------------------------------------------------
// Gameplay transitions.
// ---------------------------------------------------------------------------
function chooseRelic(id: RelicId): void {
  state.relic = id;
  state.maxSteps = BASE_MAX_STEPS + (id === 'seaLegs' ? SEA_LEGS_BONUS : 0);
  state.runStart = performance.now(); // the flood clock starts NOW
  state.phase = 'playing';
}

function finishMove(now: number): void {
  const mv = state.move!;
  state.move = null;
  state.playerR = mv.toR;
  state.playerC = mv.toC;
  state.stepsUsed += 1;

  resolveTile(mv.toR, mv.toC);

  // Wading: stepping into a flooded row costs 1 HP (the lifeboat is safe —
  // it floats).
  if (
    state.hp > 0 &&
    isRowFlooded(mv.toR, now) &&
    state.grid![mv.toR][mv.toC] !== 'lifeboat'
  ) {
    const { x, y } = tileCenter(mv.toR, mv.toC);
    state.hp -= 1;
    sfx('splash');
    burst(x, y, COLORS.breachFoam);
    state.shake = { mag: TILE * 0.12, until: now + 220 };
  }

  if (state.hp <= 0) return endRun('drowned');
  if (state.grid![mv.toR][mv.toC] === 'lifeboat') return endRun('escaped');
  if (state.stepsUsed >= state.maxSteps) return endRun('stranded');
}

/** Once per row: if the flood catches the tile you're standing on, you get hit. */
function applyFloodCatchUp(now: number): void {
  if (state.phase !== 'playing' || state.move) return;
  const pr = Math.round(state.playerR);
  if (isRowFlooded(pr, now) && state.floodDamageRow < pr) {
    state.floodDamageRow = pr;
    const { x, y } = tileCenter(pr, Math.round(state.playerC));
    state.hp -= 1;
    sfx('splash');
    burst(x, y, COLORS.breachFoam);
    state.shake = { mag: TILE * 0.15, until: now + 250 };
    if (state.hp <= 0) endRun('drowned');
  }
}

function resolveTile(r: number, c: number): void {
  const grid = state.grid!;
  const tile = grid[r][c];
  const { x: cx, y: cy } = tileCenter(r, c);

  switch (tile) {
    case 'pearl': {
      state.score += POINTS.pearl * (state.relic === 'compass' ? 2 : 1);
      sfx('pearl');
      burst(cx, cy, COLORS.pearlCore);
      grid[r][c] = 'empty';
      break;
    }
    case 'crate': {
      state.score += POINTS.crate;
      sfx('crate');
      burst(cx, cy, COLORS.gold);
      grid[r][c] = 'empty';
      break;
    }
    case 'shark': {
      if (state.relic === 'harpoon') {
        state.score += POINTS.harpoonKill;
        sfx('crate');
        burst(cx, cy, COLORS.gold);
      } else {
        damagePlayer(cx, cy);
      }
      grid[r][c] = 'empty';
      break;
    }
    case 'breach': {
      damagePlayer(cx, cy);
      grid[r][c] = 'empty';
      break;
    }
    case 'lifeboat': {
      const leftover = Math.max(0, state.maxSteps - state.stepsUsed);
      state.score += POINTS.lifeboat + leftover * POINTS.perLeftoverStep;
      burst(cx, cy, COLORS.lifeboat);
      break;
    }
    default:
      break;
  }
}

function damagePlayer(cx: number, cy: number): void {
  state.hp -= 1;
  sfx('hurt');
  burst(cx, cy, COLORS.danger);
  state.shake = { mag: TILE * 0.18, until: performance.now() + 280 };
}

function endRun(ending: Ending): void {
  state.ending = ending;
  state.runEnd = performance.now();
  state.phase = 'gameover';
  sfx(ending === 'escaped' ? 'win' : 'lose');
  if (!state.practice) {
    void submitRun();
  } else {
    state.submitState = 'done';
    state.submitMsg = 'Practice run — not logged. New scored voyage at midnight UTC.';
  }
}

function burst(x: number, y: number, hue: string): void {
  const now = performance.now();
  for (let i = 0; i < 3; i++) {
    state.particles.push({ x, y, born: now + i * 60, life: 520, hue });
  }
}

// ---------------------------------------------------------------------------
// Submit.
// ---------------------------------------------------------------------------
async function submitRun(): Promise<void> {
  if (state.submitState !== 'idle') return;
  state.submitState = 'sending';
  try {
    const res = await fetch('/api/submitRun', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: state.score }),
    });
    const data: SubmitData = await res.json();
    if (res.ok && data.ok) {
      state.submitState = 'done';
      state.submit = data;
      if (state.init) {
        state.init.playedToday = true;
        state.init.todayScore = data.score;
        state.init.personalBest = data.personalBest;
        state.init.streak = data.streak;
        state.init.leaderboard = data.leaderboard;
      }
    } else if (res.status === 409) {
      state.submitState = 'done';
      state.submitMsg = data.message ?? 'Already logged today.';
    } else {
      state.submitState = 'error';
      state.submitMsg = data.message ?? 'Could not save your run.';
    }
  } catch (err) {
    state.submitState = 'error';
    state.submitMsg = `Network error: ${String(err)}`;
  }
}

function nextShipCountdown(): string {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  let s = Math.max(0, Math.floor((next - now.getTime()) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// ===========================================================================
//  RENDER LOOP
// ===========================================================================
function frame(now: number): void {
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  state.hitboxes = [];

  switch (state.phase) {
    case 'loading':
      drawLoading(now);
      break;
    case 'title':
      drawTitle(now);
      break;
    case 'relic':
      drawRelicSelect(now);
      break;
    case 'playing':
      updateMove(now);
      applyFloodCatchUp(now);
      drawGame(now);
      break;
    case 'gameover':
      drawGame(now);
      drawGameOver(now);
      break;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function updateMove(now: number): void {
  if (!state.move) return;
  const mv = state.move;
  const t = Math.min(1, (now - mv.start) / MOVE_MS);
  const e = t * t * (3 - 2 * t);
  state.playerR = mv.fromR + (mv.toR - mv.fromR) * e;
  state.playerC = mv.fromC + (mv.toC - mv.fromC) * e;
  if (t >= 1) finishMove(now);
}

// ---------------------------------------------------------------------------
// Screen: loading
// ---------------------------------------------------------------------------
function drawLoading(now: number): void {
  paintSeaBackdrop(now);
  ctx.fillStyle = COLORS.hud;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.floor(VIEW_W * 0.05)}px sans-serif`;
  const dots = '.'.repeat(1 + (Math.floor(now / 400) % 3));
  ctx.fillText(`Boarding the ship${dots}`, VIEW_W / 2, VIEW_H / 2);
}

// ---------------------------------------------------------------------------
// Screen: title
// ---------------------------------------------------------------------------
function drawTitle(now: number): void {
  paintSeaBackdrop(now);

  // Moon + halo.
  const moonX = VIEW_W * 0.78;
  const moonY = VIEW_H * 0.1;
  const moonR = VIEW_W * 0.06;
  const halo = ctx.createRadialGradient(moonX, moonY, moonR * 0.4, moonX, moonY, moonR * 3);
  halo.addColorStop(0, 'rgba(240, 244, 210, 0.35)');
  halo.addColorStop(1, 'rgba(240, 244, 210, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(moonX - moonR * 3, moonY - moonR * 3, moonR * 6, moonR * 6);
  ctx.fillStyle = '#f0f4d2';
  ctx.beginPath();
  ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
  ctx.fill();

  drawSinkingShip(now, VIEW_W * 0.5, VIEW_H * 0.36, VIEW_W * 0.62);
  drawWaveBand(now, VIEW_H * 0.42, VIEW_H, 0.55);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const bob = Math.sin(now / 900) * VIEW_H * 0.004;
  ctx.fillStyle = COLORS.gold;
  ctx.font = `800 ${Math.floor(VIEW_W * 0.115)}px sans-serif`;
  ctx.fillText('LAST VOYAGE', VIEW_W / 2, VIEW_H * 0.55 + bob);
  ctx.fillStyle = COLORS.hud;
  ctx.font = `500 ${Math.floor(VIEW_W * 0.036)}px sans-serif`;
  ctx.fillText('Grab the pearls. Dodge the sharks. Reach the lifeboat.', VIEW_W / 2, VIEW_H * 0.61 + bob);

  if (state.error) {
    ctx.fillStyle = COLORS.danger;
    ctx.font = `500 ${Math.floor(VIEW_W * 0.028)}px sans-serif`;
    wrapText(state.error, VIEW_W / 2, VIEW_H * 0.655, VIEW_W * 0.9, VIEW_W * 0.04);
  }

  const init = state.init;

  if (init) {
    const chips: string[] = [];
    if (init.streak > 0) chips.push(`🔥 ${init.streak}-day streak`);
    if (init.personalBest > 0) chips.push(`⭐ best ${init.personalBest}`);
    chips.push(`⚓ r/${init.subreddit}`);
    ctx.fillStyle = COLORS.hudDim;
    ctx.font = `600 ${Math.floor(VIEW_W * 0.032)}px sans-serif`;
    ctx.fillText(chips.join('    '), VIEW_W / 2, VIEW_H * 0.69);
  }

  const played = Boolean(init?.playedToday);
  const btnW = VIEW_W * 0.56;
  const btnH = VIEW_H * 0.085;
  const btnX = (VIEW_W - btnW) / 2;
  const btnY = VIEW_H * 0.735;
  const pulse = 0.5 + 0.5 * Math.sin(now / 400);

  ctx.fillStyle = played ? 'rgba(47, 168, 255, 0.25)' : COLORS.lifeboat;
  roundRect(btnX, btnY, btnW, btnH, 16);
  ctx.fill();
  ctx.strokeStyle = played ? COLORS.shirt : `rgba(255, 232, 214, ${0.5 + pulse * 0.5})`;
  ctx.lineWidth = 3;
  roundRect(btnX, btnY, btnW, btnH, 16);
  ctx.stroke();

  ctx.fillStyle = played ? COLORS.hud : '#2b1206';
  ctx.font = `800 ${Math.floor(btnH * 0.42)}px sans-serif`;
  ctx.fillText(played ? '⛵ PRACTICE RUN' : '🚢 SET SAIL', VIEW_W / 2, btnY + btnH / 2);
  state.hitboxes.push({ id: 'play', x: btnX, y: btnY, w: btnW, h: btnH });

  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `500 ${Math.floor(VIEW_W * 0.03)}px sans-serif`;
  if (played && init) {
    ctx.fillText(
      `Today: ${init.todayScore ?? 0} pts  •  next ship in ${nextShipCountdown()}`,
      VIEW_W / 2,
      btnY + btnH + VIEW_H * 0.035
    );
  } else if (init) {
    ctx.fillText(
      `One scored voyage per day — today's ship: ${init.board.date}`,
      VIEW_W / 2,
      btnY + btnH + VIEW_H * 0.035
    );
  }

  if (init && init.leaderboard.length > 0) {
    const medals = ['🥇', '🥈', '🥉'];
    const top = init.leaderboard.slice(0, 3);
    const line = top.map((row, i) => `${medals[i]} ${row.member} ${row.score}`).join('   ');
    ctx.fillStyle = COLORS.hudDim;
    ctx.font = `600 ${Math.floor(VIEW_W * 0.028)}px sans-serif`;
    ctx.fillText(line, VIEW_W / 2, VIEW_H * 0.93);
  }
}

function drawSinkingShip(now: number, cx: number, cy: number, width: number): void {
  const tilt = -0.16 + Math.sin(now / 2400) * 0.012;
  const w = width;
  const hullH = w * 0.16;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);

  ctx.fillStyle = COLORS.shipDark;
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.lineTo(w / 2, 0);
  ctx.lineTo(w * 0.38, hullH);
  ctx.lineTo(-w * 0.42, hullH);
  ctx.closePath();
  ctx.fill();

  ctx.fillRect(-w * 0.18, -hullH * 0.75, w * 0.3, hullH * 0.75);
  ctx.fillRect(-w * 0.1, -hullH * 1.5, w * 0.05, hullH * 0.8);
  ctx.fillRect(w * 0.02, -hullH * 1.5, w * 0.05, hullH * 0.8);

  ctx.fillStyle = 'rgba(255, 210, 63, 0.75)';
  for (let i = 2; i < 6; i++) {
    const px = -w * 0.38 + i * w * 0.13;
    ctx.beginPath();
    ctx.arc(px, hullH * 0.45, w * 0.011, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  const sternX = cx - Math.cos(tilt) * (w / 2) * 0.92;
  const sternY = cy + Math.sin(-tilt) * (w / 2) * 0.92;
  ctx.fillStyle = 'rgba(197, 233, 250, 0.5)';
  for (let i = 0; i < 5; i++) {
    const phase = (now / 1000 + i * 0.7) % 2;
    const bx = sternX + Math.sin(now / 300 + i * 2) * w * 0.02 + i * w * 0.012;
    const by = sternY - phase * w * 0.05;
    const br = w * 0.006 * (1 + i * 0.3) * (1 - phase / 2.2);
    if (br <= 0) continue;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWaveBand(now: number, yTop: number, yBottom: number, alpha: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, yBottom);
  ctx.lineTo(0, yTop);
  const segs = 24;
  for (let i = 0; i <= segs; i++) {
    const x = (i / segs) * VIEW_W;
    const y = yTop + Math.sin(now / 700 + i * 0.55) * VIEW_H * 0.008;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(VIEW_W, yBottom);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, yTop, 0, yBottom);
  g.addColorStop(0, `rgba(103, 199, 239, ${alpha * 0.5})`);
  g.addColorStop(1, `rgba(8, 49, 76, ${alpha})`);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Screen: relic selection
// ---------------------------------------------------------------------------
function drawRelicSelect(now: number): void {
  paintSeaBackdrop(now);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = COLORS.gold;
  ctx.font = `800 ${Math.floor(VIEW_W * 0.08)}px sans-serif`;
  ctx.fillText('CHOOSE YOUR RELIC', VIEW_W / 2, VIEW_H * 0.13);

  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `500 ${Math.floor(VIEW_W * 0.034)}px sans-serif`;
  ctx.fillText(
    state.practice ? 'Practice run — experiment freely!' : 'One relic. One voyage. Choose well.',
    VIEW_W / 2,
    VIEW_H * 0.19
  );

  const cardW = VIEW_W * 0.82;
  const cardH = VIEW_H * 0.125;
  const cardX = (VIEW_W - cardW) / 2;
  const gap = VIEW_H * 0.03;
  let cardY = VIEW_H * 0.27;

  for (const relic of RELICS) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 500 + cardY);
    ctx.fillStyle = COLORS.panel;
    roundRect(cardX, cardY, cardW, cardH, 14);
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 210, 63, ${0.35 + pulse * 0.4})`;
    ctx.lineWidth = 2;
    roundRect(cardX, cardY, cardW, cardH, 14);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = `${Math.floor(cardH * 0.48)}px sans-serif`;
    ctx.fillText(relic.emoji, cardX + cardW * 0.05, cardY + cardH * 0.52);

    ctx.fillStyle = COLORS.gold;
    ctx.font = `700 ${Math.floor(cardH * 0.28)}px sans-serif`;
    ctx.fillText(relic.name, cardX + cardW * 0.2, cardY + cardH * 0.36);
    ctx.fillStyle = COLORS.hud;
    ctx.font = `500 ${Math.floor(cardH * 0.22)}px sans-serif`;
    ctx.fillText(relic.blurb, cardX + cardW * 0.2, cardY + cardH * 0.68);
    ctx.textAlign = 'center';

    state.hitboxes.push({ id: `relic:${relic.id}`, x: cardX, y: cardY, w: cardW, h: cardH });
    cardY += cardH + gap;
  }

  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `500 ${Math.floor(VIEW_W * 0.028)}px sans-serif`;
  ctx.fillText('🦪 pearl +10   📦 crate +50   🦈 / 🌀 −1 HP   🚣 escape +100', VIEW_W / 2, cardY + VIEW_H * 0.015);
  ctx.fillStyle = COLORS.breachFoam;
  ctx.font = `600 ${Math.floor(VIEW_W * 0.03)}px sans-serif`;
  ctx.fillText('⚠️ The stern floods over time — keep moving or wade at your peril!', VIEW_W / 2, cardY + VIEW_H * 0.055);
}

// ---------------------------------------------------------------------------
// Screen: the game.
// Painter's order for the 2.5D look:
//   sea backdrop → hull side → deck tiles (beveled) → move hints → railing →
//   per-row: entities standing on tiles (+player inserted at its row) →
//   flood water volume → particles → HUD → practice watermark
// ---------------------------------------------------------------------------
function drawGame(now: number): void {
  paintSeaBackdrop(now);

  ctx.save();
  if (now < state.shake.until) {
    const falloff = (state.shake.until - now) / 280;
    const mag = state.shake.mag * falloff;
    ctx.translate((Math.random() - 0.5) * mag * 2, (Math.random() - 0.5) * mag * 2);
  }

  drawHullSide(now);
  drawDeck(now);
  drawRailing();
  drawEntitiesAndPlayer(now);
  drawFloodWater(now);
  drawParticles(now);

  ctx.restore();

  drawHud(now);

  if (state.practice && state.phase === 'playing') {
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = COLORS.hud;
    ctx.font = `800 ${Math.floor(VIEW_W * 0.13)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(VIEW_W / 2, BOARD_Y + BOARD_PX / 2);
    ctx.rotate(-0.35);
    ctx.fillText('PRACTICE', 0, 0);
    ctx.restore();
  }
}

/** The ship's hull cross-section below the deck — sells the "floating" depth. */
function drawHullSide(now: number): void {
  const y = BOARD_Y + BOARD_PX + RAIL;
  const h = VIEW_H - y;
  ctx.fillStyle = COLORS.hullSide;
  ctx.beginPath();
  ctx.moveTo(BOARD_X - RAIL, y);
  ctx.lineTo(BOARD_X + BOARD_PX + RAIL, y);
  ctx.lineTo(BOARD_X + BOARD_PX + RAIL * 0.4, y + h);
  ctx.lineTo(BOARD_X - RAIL * 0.4, y + h);
  ctx.closePath();
  ctx.fill();
  // Waterline lapping against the hull.
  ctx.strokeStyle = 'rgba(127, 212, 255, 0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = BOARD_X - RAIL; x <= BOARD_X + BOARD_PX + RAIL; x += 10) {
    const wy = y + h * 0.5 + Math.sin(x / 26 + now / 300) * 4;
    if (x === BOARD_X - RAIL) ctx.moveTo(x, wy);
    else ctx.lineTo(x, wy);
  }
  ctx.stroke();
}

/** Beveled deck tiles — the chunky "GBA overworld" ground. */
function drawDeck(now: number): void {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const x = BOARD_X + c * TILE;
      const y = BOARD_Y + r * TILE;

      // Base plank color, alternating for a subtle checker.
      ctx.fillStyle = (r + c) % 2 === 0 ? COLORS.deckLight : COLORS.deckDark;
      ctx.fillRect(x, y, TILE, TILE);

      // Bevel: light top edge + dark bottom edge give each tile thickness.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(x, y, TILE, TILE * 0.1);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
      ctx.fillRect(x, y + TILE * 0.88, TILE, TILE * 0.12);

      // Horizontal plank seams.
      ctx.strokeStyle = COLORS.deckSeam;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + TILE * 0.5);
      ctx.lineTo(x + TILE, y + TILE * 0.5);
      ctx.stroke();
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
    }
  }

  // Legal move hints.
  if (state.phase === 'playing' && !state.move) {
    const pr = Math.round(state.playerR);
    const pc = Math.round(state.playerC);
    const nbrs: Array<[number, number]> = [
      [pr - 1, pc],
      [pr + 1, pc],
      [pr, pc - 1],
      [pr, pc + 1],
    ];
    const pulse = 0.2 + 0.12 * Math.sin(now / 300);
    ctx.fillStyle = `rgba(103, 199, 239, ${pulse + 0.1})`;
    for (const [r, c] of nbrs) {
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue;
      ctx.fillRect(BOARD_X + c * TILE, BOARD_Y + r * TILE, TILE, TILE);
    }
  }
}

/** Wooden railing frame with posts, wrapping the deck. */
function drawRailing(): void {
  const x0 = BOARD_X - RAIL;
  const y0 = BOARD_Y - RAIL;
  const outer = BOARD_PX + RAIL * 2;

  ctx.fillStyle = COLORS.railWood;
  // top, left, right, bottom rails
  ctx.fillRect(x0, y0, outer, RAIL);
  ctx.fillRect(x0, y0, RAIL, outer);
  ctx.fillRect(x0 + outer - RAIL, y0, RAIL, outer);
  ctx.fillRect(x0, y0 + outer - RAIL, outer, RAIL);

  // Dark inner lip (the rail's shadow onto the deck).
  ctx.strokeStyle = COLORS.railWoodDark;
  ctx.lineWidth = 2;
  ctx.strokeRect(BOARD_X - 1, BOARD_Y - 1, BOARD_PX + 2, BOARD_PX + 2);

  // Rail posts along the top rail (little vertical nubs = depth cue).
  ctx.fillStyle = COLORS.railWoodDark;
  for (let i = 0; i <= BOARD_SIZE; i++) {
    const px = BOARD_X + i * TILE - RAIL * 0.15;
    ctx.fillRect(px, y0 + RAIL * 0.15, RAIL * 0.3, RAIL * 0.7);
  }
}

/**
 * Entities + player, painted row by row (top to bottom) so that anything
 * standing on a lower tile overlaps what's behind it — the classic JRPG
 * painter's trick that makes a flat grid read as 3/4 perspective.
 */
function drawEntitiesAndPlayer(now: number): void {
  const grid = state.grid!;
  const playerRow = state.playerR; // fractional mid-lerp

  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const { x: cx, y: cy } = tileCenter(r, c);
      switch (grid[r][c]) {
        case 'pearl':
          drawPearl(cx, cy, now);
          break;
        case 'crate':
          drawCrate(cx, cy);
          break;
        case 'shark':
          drawShark(cx, cy, now);
          break;
        case 'breach':
          drawBreach(cx, cy, now);
          break;
        case 'lifeboat':
          drawLifeboat(cx, cy, now);
          break;
        default:
          break;
      }
    }
    // Insert the player right after their own row so lower rows overlap them.
    if (Math.round(playerRow) === r) drawPlayer(now);
  }
}

/** Elliptical contact shadow under a standing entity. */
function shadow(cx: number, cy: number, w: number): void {
  ctx.fillStyle = COLORS.shadow;
  ctx.beginPath();
  ctx.ellipse(cx, cy + TILE * 0.3, w, w * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
}

// --- Entity primitives (all standing ON their tiles, feet at ~cy+0.3*TILE) --

function drawPearl(cx: number, cy: number, now: number): void {
  const bob = Math.sin(now / 400 + cx) * TILE * 0.05;
  const rad = TILE * 0.2;
  const py = cy + TILE * 0.05 - bob;
  shadow(cx, cy, rad * (1 - bob / TILE));

  // Open shell beneath the pearl.
  ctx.fillStyle = '#d8b78f';
  ctx.beginPath();
  ctx.ellipse(cx, cy + TILE * 0.22, rad * 1.35, rad * 0.55, 0, 0, Math.PI);
  ctx.fill();

  const g = ctx.createRadialGradient(cx - rad * 0.3, py - rad * 0.3, rad * 0.2, cx, py, rad);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.5, COLORS.pearl);
  g.addColorStop(1, COLORS.pearlCore);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, py, rad, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(cx - rad * 0.35, py - rad * 0.35, rad * 0.2, 0, Math.PI * 2);
  ctx.fill();
}

/** A 3D crate: top face + front face, like a mini isometric box. */
function drawCrate(cx: number, cy: number): void {
  const s = TILE * 0.52;
  const topH = s * 0.38;
  const x = cx - s / 2;
  const frontY = cy - TILE * 0.02;
  shadow(cx, cy, s * 0.55);

  // Front face.
  ctx.fillStyle = COLORS.crateFront;
  ctx.fillRect(x, frontY, s, TILE * 0.32);
  // Top face (lighter = light from above).
  ctx.fillStyle = COLORS.crateTop;
  ctx.beginPath();
  ctx.moveTo(x, frontY);
  ctx.lineTo(x + s * 0.14, frontY - topH);
  ctx.lineTo(x + s + s * 0.14, frontY - topH);
  ctx.lineTo(x + s, frontY);
  ctx.closePath();
  ctx.fill();

  // Banding.
  ctx.strokeStyle = COLORS.crateBand;
  ctx.lineWidth = Math.max(2, TILE * 0.035);
  ctx.strokeRect(x, frontY, s, TILE * 0.32);
  ctx.beginPath();
  ctx.moveTo(x, frontY);
  ctx.lineTo(x + s, frontY + TILE * 0.32);
  ctx.moveTo(x + s, frontY);
  ctx.lineTo(x, frontY + TILE * 0.32);
  ctx.stroke();
}

function drawShark(cx: number, cy: number, now: number): void {
  const sway = Math.sin(now / 300 + cy) * TILE * 0.05;
  const bodyR = TILE * 0.28;
  shadow(cx + sway, cy, bodyR * 1.1);
  ctx.save();
  ctx.translate(cx + sway, cy + TILE * 0.02);

  ctx.fillStyle = COLORS.shark;
  ctx.beginPath();
  ctx.ellipse(0, 0, bodyR * 1.15, bodyR * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = COLORS.sharkBelly;
  ctx.beginPath();
  ctx.ellipse(0, bodyR * 0.28, bodyR * 0.9, bodyR * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = COLORS.shark;
  ctx.beginPath();
  ctx.moveTo(-bodyR * 0.1, -bodyR * 0.7);
  ctx.lineTo(bodyR * 0.25, -bodyR * 1.35);
  ctx.lineTo(bodyR * 0.5, -bodyR * 0.6);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(bodyR * 1.05, 0);
  ctx.lineTo(bodyR * 1.6, -bodyR * 0.5);
  ctx.lineTo(bodyR * 1.6, bodyR * 0.5);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#0b0b0b';
  ctx.beginPath();
  ctx.arc(-bodyR * 0.5, -bodyR * 0.1, bodyR * 0.12, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.5, TILE * 0.03);
  ctx.beginPath();
  ctx.moveTo(-bodyR * 0.9, bodyR * 0.15);
  ctx.lineTo(-bodyR * 0.2, bodyR * 0.15);
  ctx.stroke();

  ctx.restore();
}

function drawBreach(cx: number, cy: number, now: number): void {
  const spin = now / 600;
  const spikes = 9;
  const outer = TILE * 0.3;
  const inner = TILE * 0.15;
  // A breach is a hole — darken the tile beneath instead of a drop shadow.
  ctx.fillStyle = 'rgba(4, 18, 30, 0.45)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + TILE * 0.06, outer * 1.25, outer * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(spin);
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const rad = i % 2 === 0 ? outer : inner;
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const px = Math.cos(a) * rad;
    const py = Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = COLORS.breach;
  ctx.fill();
  ctx.strokeStyle = COLORS.breachFoam;
  ctx.lineWidth = Math.max(1.5, TILE * 0.03);
  ctx.stroke();
  ctx.rotate(-spin * 2);
  ctx.beginPath();
  ctx.arc(0, 0, inner * 0.6, 0, Math.PI * 1.5);
  ctx.stroke();
  ctx.restore();
}

function drawLifeboat(cx: number, cy: number, now: number): void {
  const bob = Math.sin(now / 350) * TILE * 0.03;
  const w = TILE * 0.68;
  const h = TILE * 0.34;

  const pulse = 0.5 + 0.5 * Math.sin(now / 350);
  const glow = ctx.createRadialGradient(cx, cy, TILE * 0.1, cx, cy, TILE * 0.55);
  glow.addColorStop(0, `rgba(255, 107, 61, ${0.25 + pulse * 0.2})`);
  glow.addColorStop(1, 'rgba(255, 107, 61, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - TILE * 0.55, cy - TILE * 0.55, TILE * 1.1, TILE * 1.1);

  shadow(cx, cy, w * 0.5);
  ctx.save();
  ctx.translate(cx, cy + bob);

  // Hull with a visible side face (two-tone = 3/4 view).
  ctx.fillStyle = COLORS.lifeboat;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h * 0.15);
  ctx.quadraticCurveTo(0, h * 1.05, w / 2, -h * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = COLORS.lifeboatDark;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h * 0.15);
  ctx.quadraticCurveTo(0, h * 0.35, w / 2, -h * 0.15);
  ctx.quadraticCurveTo(0, h * 0.05, -w / 2, -h * 0.15);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = COLORS.lifeboatTrim;
  ctx.lineWidth = Math.max(2, TILE * 0.05);
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h * 0.15);
  ctx.lineTo(w / 2, -h * 0.15);
  ctx.stroke();

  ctx.lineWidth = Math.max(1.5, TILE * 0.03);
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.15);
  ctx.lineTo(0, -h * 0.95);
  ctx.stroke();
  ctx.fillStyle = COLORS.gold;
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.95);
  ctx.lineTo(w * 0.28, -h * 0.77);
  ctx.lineTo(0, -h * 0.6);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/**
 * The survivor: a chibi character with head, orange life-vest, and little
 * legs — faces the direction of travel and hops while gliding between tiles.
 */
function drawPlayer(now: number): void {
  const cx = BOARD_X + state.playerC * TILE + TILE / 2;
  const cyBase = BOARD_Y + state.playerR * TILE + TILE / 2;

  // Mid-move hop (sin arc over the lerp) or a gentle idle bob.
  let hop = 0;
  if (state.move) {
    const t = Math.min(1, (now - state.move.start) / MOVE_MS);
    hop = Math.sin(t * Math.PI) * TILE * 0.14;
  } else {
    hop = Math.max(0, Math.sin(now / 350)) * TILE * 0.02;
  }
  const cy = cyBase - hop;

  const headR = TILE * 0.14;
  const bodyW = TILE * 0.3;
  const bodyH = TILE * 0.26;

  shadow(cx, cyBase, TILE * 0.2 * (1 - hop / TILE));

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(state.facing, 1); // flip horizontally to face travel direction

  // Legs.
  const step = state.move ? Math.sin(now / 40) * TILE * 0.04 : 0;
  ctx.fillStyle = COLORS.pants;
  ctx.fillRect(-bodyW * 0.32, TILE * 0.12 + step, bodyW * 0.26, TILE * 0.14);
  ctx.fillRect(bodyW * 0.06, TILE * 0.12 - step, bodyW * 0.26, TILE * 0.14);

  // Body (shirt) with vest overlay.
  ctx.fillStyle = COLORS.shirt;
  roundRect(-bodyW / 2, -bodyH * 0.4, bodyW, bodyH, bodyW * 0.25);
  ctx.fill();
  ctx.fillStyle = COLORS.vest;
  roundRect(-bodyW / 2, -bodyH * 0.4, bodyW, bodyH * 0.62, bodyW * 0.25);
  ctx.fill();
  // Vest strap.
  ctx.strokeStyle = COLORS.lifeboatTrim;
  ctx.lineWidth = Math.max(1.5, TILE * 0.025);
  ctx.beginPath();
  ctx.moveTo(-bodyW * 0.28, -bodyH * 0.28);
  ctx.lineTo(bodyW * 0.28, -bodyH * 0.05);
  ctx.stroke();

  // Head with a hint of a face (eye dot) on the leading side.
  ctx.fillStyle = COLORS.skin;
  ctx.beginPath();
  ctx.arc(0, -bodyH * 0.4 - headR * 0.9, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#20303c';
  ctx.beginPath();
  ctx.arc(headR * 0.42, -bodyH * 0.4 - headR, headR * 0.16, 0, Math.PI * 2);
  ctx.fill();
  // Hair.
  ctx.fillStyle = '#5b4426';
  ctx.beginPath();
  ctx.arc(0, -bodyH * 0.4 - headR * 1.15, headR * 0.85, Math.PI, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * The flood — a translucent water VOLUME sliding down from the stern (top of
 * the board) in real time. Submerged tiles get a depth tint, a foam line
 * marks the moving edge, and caustic shimmers play over the surface.
 */
function drawFloodWater(now: number): void {
  const level = floodLevel(now); // 0..8 rows, continuous
  if (level <= 0) {
    return;
  }
  const edgeY = BOARD_Y + level * TILE;
  const topY = BOARD_Y - RAIL;
  const amp = TILE * 0.09;
  const segs = 26;

  // Water body with a vertical depth gradient (darker = deeper = older).
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(BOARD_X - RAIL, topY);
  ctx.lineTo(BOARD_X + BOARD_PX + RAIL, topY);
  ctx.lineTo(BOARD_X + BOARD_PX + RAIL, edgeY);
  for (let i = segs; i >= 0; i--) {
    const x = BOARD_X - RAIL + (i / segs) * (BOARD_PX + RAIL * 2);
    const y = edgeY + Math.sin(now / 280 + i * 0.7) * amp;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, topY, 0, edgeY);
  grad.addColorStop(0, 'rgba(9, 58, 89, 0.85)');
  grad.addColorStop(0.7, 'rgba(23, 108, 153, 0.72)');
  grad.addColorStop(1, 'rgba(103, 199, 239, 0.55)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.clip(); // keep shimmer + foam inside the water body

  // Caustic shimmer: drifting bright sine ribbons.
  ctx.strokeStyle = 'rgba(197, 233, 250, 0.18)';
  ctx.lineWidth = 2;
  for (let band = 0; band < 4; band++) {
    const by = topY + ((edgeY - topY) * (band + 0.5)) / 4;
    ctx.beginPath();
    for (let x = BOARD_X - RAIL; x <= BOARD_X + BOARD_PX + RAIL; x += 12) {
      const y = by + Math.sin(x / 30 + now / 400 + band * 2) * 5;
      if (x === BOARD_X - RAIL) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Foam crest along the advancing edge.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let i = 0; i <= segs; i++) {
    const x = BOARD_X - RAIL + (i / segs) * (BOARD_PX + RAIL * 2);
    const y = edgeY + Math.sin(now / 280 + i * 0.7) * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Warning tint on the next row about to flood (last 3 seconds).
  const nextRow = Math.floor(level + 0.4);
  if (nextRow < BOARD_SIZE && state.phase === 'playing') {
    const tLeft = secondsUntilFlood(nextRow, now);
    if (tLeft < 3) {
      const flash = 0.1 + 0.12 * Math.abs(Math.sin(now / 180));
      ctx.fillStyle = `rgba(127, 212, 255, ${flash})`;
      ctx.fillRect(BOARD_X, BOARD_Y + nextRow * TILE, BOARD_PX, TILE);
    }
  }
}

function drawParticles(now: number): void {
  ctx.save();
  state.particles = state.particles.filter((p) => now - p.born < p.life);
  for (const p of state.particles) {
    const age = now - p.born;
    if (age < 0) continue;
    const t = age / p.life;
    const rad = TILE * (0.1 + t * 0.5);
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = p.hue;
    ctx.lineWidth = Math.max(1.5, TILE * 0.05 * (1 - t));
    ctx.beginPath();
    ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHud(now: number): void {
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(0, 0, VIEW_W, HUD_H);

  const pad = VIEW_W * 0.04;
  ctx.textBaseline = 'middle';

  ctx.textAlign = 'left';
  ctx.font = `${Math.floor(HUD_H * 0.32)}px sans-serif`;
  let hearts = '';
  for (let i = 0; i < START_HP; i++) hearts += i < state.hp ? '❤️' : '🖤';
  ctx.fillText(hearts, pad, HUD_H * 0.3);

  const relic = RELICS.find((r) => r.id === state.relic);
  if (relic) {
    ctx.fillStyle = COLORS.hudDim;
    ctx.font = `500 ${Math.floor(HUD_H * 0.19)}px sans-serif`;
    ctx.fillText(`${relic.emoji} ${relic.name}`, pad, HUD_H * 0.72);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.gold;
  ctx.font = `800 ${Math.floor(HUD_H * 0.34)}px sans-serif`;
  ctx.fillText(`${state.score}`, VIEW_W - pad, HUD_H * 0.3);

  const left = Math.max(0, state.maxSteps - state.stepsUsed);
  const low = left <= 4;
  const flash = low && Math.floor(now / 400) % 2 === 0;
  ctx.fillStyle = flash ? COLORS.danger : low ? '#ffb1b1' : COLORS.hudDim;
  ctx.font = `600 ${Math.floor(HUD_H * 0.2)}px sans-serif`;
  ctx.fillText(`${left} ${left === 1 ? 'move' : 'moves'} left`, VIEW_W - pad, HUD_H * 0.72);

  // Flood status, centered: grace countdown, then "row sinks in Xs".
  if (state.phase === 'playing') {
    ctx.textAlign = 'center';
    const level = floodLevel(now);
    const nextRow = Math.min(BOARD_SIZE - 1, Math.floor(level + 0.4));
    const tLeft = secondsUntilFlood(nextRow, now);
    ctx.fillStyle = level > 0 || tLeft < 6 ? COLORS.breachFoam : COLORS.hudDim;
    ctx.font = `600 ${Math.floor(HUD_H * 0.19)}px sans-serif`;
    const label =
      level <= 0
        ? `🌊 flooding in ${Math.ceil(secondsUntilFlood(0, now))}s`
        : `🌊 row ${nextRow + 1} sinks in ${Math.ceil(tLeft)}s`;
    ctx.fillText(label, VIEW_W / 2, HUD_H * 0.5);
  }
}

// ---------------------------------------------------------------------------
// Screen: game over
// ---------------------------------------------------------------------------
function drawGameOver(now: number): void {
  ctx.fillStyle = 'rgba(1, 18, 31, 0.8)';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const titleMap: Record<Exclude<Ending, null>, { text: string; color: string }> = {
    escaped: { text: '🚣 YOU ESCAPED!', color: COLORS.lifeboat },
    drowned: { text: '🌊 YOU WENT UNDER', color: COLORS.breachFoam },
    stranded: { text: '⏳ OUT OF MOVES', color: COLORS.gold },
  };
  const info = state.ending ? titleMap[state.ending] : { text: 'GAME OVER', color: COLORS.hud };

  ctx.fillStyle = info.color;
  ctx.font = `800 ${Math.floor(VIEW_W * 0.08)}px sans-serif`;
  ctx.fillText(info.text, VIEW_W / 2, VIEW_H * 0.12);

  ctx.fillStyle = COLORS.gold;
  ctx.font = `800 ${Math.floor(VIEW_W * 0.14)}px sans-serif`;
  ctx.fillText(`${state.score}`, VIEW_W / 2, VIEW_H * 0.22);

  const sub = state.submit;
  if (sub?.isNewBest) {
    const pulse = 0.6 + 0.4 * Math.sin(now / 250);
    ctx.fillStyle = `rgba(255, 210, 63, ${pulse})`;
    ctx.font = `800 ${Math.floor(VIEW_W * 0.04)}px sans-serif`;
    ctx.fillText('★ NEW PERSONAL BEST ★', VIEW_W / 2, VIEW_H * 0.29);
  } else {
    ctx.fillStyle = COLORS.hudDim;
    ctx.font = `500 ${Math.floor(VIEW_W * 0.032)}px sans-serif`;
    ctx.fillText('pearls & plunder', VIEW_W / 2, VIEW_H * 0.29);
  }

  if (sub) {
    ctx.fillStyle = COLORS.hud;
    ctx.font = `600 ${Math.floor(VIEW_W * 0.036)}px sans-serif`;
    ctx.fillText(
      `🔥 ${sub.streak}-day streak    ⚓ r/${sub.faction}: ${Math.floor(sub.factionTotal)}`,
      VIEW_W / 2,
      VIEW_H * 0.36
    );
  } else if (state.submitMsg) {
    ctx.fillStyle = state.submitState === 'error' ? COLORS.danger : COLORS.hudDim;
    ctx.font = `500 ${Math.floor(VIEW_W * 0.03)}px sans-serif`;
    wrapText(state.submitMsg, VIEW_W / 2, VIEW_H * 0.36, VIEW_W * 0.86, VIEW_W * 0.042);
  } else if (state.submitState === 'sending') {
    ctx.fillStyle = COLORS.hudDim;
    ctx.font = `500 ${Math.floor(VIEW_W * 0.03)}px sans-serif`;
    ctx.fillText(
      `Logging your voyage${'.'.repeat(1 + (Math.floor(now / 400) % 3))}`,
      VIEW_W / 2,
      VIEW_H * 0.36
    );
  }

  const rows = sub?.leaderboard ?? state.init?.leaderboard ?? [];
  if (rows.length > 0) {
    ctx.fillStyle = COLORS.gold;
    ctx.font = `700 ${Math.floor(VIEW_W * 0.038)}px sans-serif`;
    ctx.fillText("— TODAY'S SURVIVORS —", VIEW_W / 2, VIEW_H * 0.44);

    const rowH = VIEW_H * 0.045;
    const top = rows.slice(0, 5);
    const you = sub?.you ?? state.init?.username ?? '';
    let y = VIEW_H * 0.49;
    for (let i = 0; i < top.length; i++) {
      const row = top[i];
      const isYou = row.member === you;
      ctx.fillStyle = isYou ? COLORS.gold : COLORS.hud;
      ctx.font = `${isYou ? 800 : 500} ${Math.floor(VIEW_W * 0.034)}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(`${i + 1}. ${row.member}${isYou ? '  ← you' : ''}`, VIEW_W * 0.14, y);
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.floor(row.score)}`, VIEW_W * 0.86, y);
      y += rowH;
    }
    ctx.textAlign = 'center';
  }

  const btnW = VIEW_W * 0.5;
  const btnH = VIEW_H * 0.07;
  const btnX = (VIEW_W - btnW) / 2;
  const btnY = VIEW_H * 0.76;
  ctx.fillStyle = 'rgba(47, 168, 255, 0.25)';
  roundRect(btnX, btnY, btnW, btnH, 14);
  ctx.fill();
  ctx.strokeStyle = COLORS.shirt;
  ctx.lineWidth = 2.5;
  roundRect(btnX, btnY, btnW, btnH, 14);
  ctx.stroke();
  ctx.fillStyle = COLORS.hud;
  ctx.font = `700 ${Math.floor(btnH * 0.42)}px sans-serif`;
  ctx.fillText('⛵ PRACTICE AGAIN', VIEW_W / 2, btnY + btnH / 2);
  state.hitboxes.push({ id: 'again', x: btnX, y: btnY, w: btnW, h: btnH });

  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `600 ${Math.floor(VIEW_W * 0.032)}px sans-serif`;
  ctx.fillText(`⏱ next ship sails in ${nextShipCountdown()}`, VIEW_W / 2, btnY + btnH + VIEW_H * 0.045);
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------
function paintSeaBackdrop(now: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
  g.addColorStop(0, '#0b3a5b');
  g.addColorStop(1, '#01121f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  ctx.strokeStyle = 'rgba(103, 199, 239, 0.12)';
  ctx.lineWidth = 2;
  for (let row = 0; row < 5; row++) {
    const baseY = (VIEW_H / 5) * row + ((now / 40) % (VIEW_H / 5));
    ctx.beginPath();
    for (let x = 0; x <= VIEW_W; x += 16) {
      const y = baseY + Math.sin(x / 40 + now / 500 + row) * 6;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(text: string, cx: number, cy: number, maxW: number, lineH: number): void {
  const words = text.split(' ');
  let line = '';
  let y = cy;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, cx, y);
      line = word;
      y += lineH;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, cx, y);
}
