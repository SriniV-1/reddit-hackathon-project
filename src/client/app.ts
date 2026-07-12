/**
 * ============================================================================
 *  LAST VOYAGE — Devvit Web client (100% HTML5 Canvas, zero image assets)
 * ============================================================================
 *  The ship is going down FAST. You start at the stern [0,0] with 3 HP and 18
 *  moves. The flood starts the moment you step on deck and swallows the whole
 *  board in 20 seconds — one row every 2.5s, chasing you toward the lifeboat
 *  at [7,7]. Grab pearls and crates on the way if you dare; wading through
 *  flooded tiles costs HP.
 *
 *  Rendering: "2.75D" — the deck is drawn as a true perspective trapezoid
 *  with a vanishing point (far rows narrower and shorter, near rows wider and
 *  taller), entities scale with depth, and everything stands on its tile with
 *  a drop shadow, painted in row order so near things overlap far things.
 *  All of it is canvas primitives; sound is synthesized WebAudio. There are
 *  no image or audio files anywhere in this app.
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
// Tunables. Move budget is simulation-backed (README): 18 gives ~4 moves of
// slack over the 14-move sprint. The flood is the real-time pressure on top.
// ---------------------------------------------------------------------------
const BOARD_SIZE = 8;
const BASE_MAX_STEPS = 18;
const SEA_LEGS_BONUS = 4;
const START_HP = 3;
const MOVE_MS = 150; // lerp duration between tiles

// Real-time flood: the water starts rising the FIRST instant of gameplay and
// fills the deck VERTICALLY — floor to over-your-head in FLOOD_TOTAL_S,
// everywhere at once (one global water level, like a room filling up).
const FLOOD_TOTAL_S = 20;

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
// Canvas + perspective layout ("2.75D").
//
// The deck is a trapezoid seen from a low three-quarter camera:
//   • far (top) rows are NARROWER and SHORTER — they converge toward a
//     vanishing point behind the horizon;
//   • near (bottom) rows are WIDER and TALLER;
//   • an entity's draw scale follows its row's tile width.
//
// All mapping goes through rcToXY(rr, cc) (continuous board coords → screen)
// and xyToRC (screen → board cell), so gameplay logic stays grid-pure.
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let VIEW_W = 0;
let VIEW_H = 0;
let HUD_H = 0;
let BOARD_PX = 0; // width of the NEAREST (bottom) row — the widest
let BOARD_H = 0; // total board height on screen
let TILE = 0; // base tile size (bottom row) — entity sizes derive from this
let BOARD_Y = 0; // y of the far edge of the deck
let RAIL = 0; // railing thickness

/** Width of the far (top) edge relative to the near (bottom) edge. */
const FAR_W = 0.78;
/** Height of the far row relative to the near row. */
const FAR_H = 0.68;

/** rowEdgeT[r] = normalized (0..1) vertical position of horizontal grid line r. */
let rowEdgeT: number[] = [];

function computePerspective(): void {
  // Far rows are vertically compressed: row r's height ∝ lerp(FAR_H, 1, r/7).
  const heights: number[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    heights.push(FAR_H + (1 - FAR_H) * (r / (BOARD_SIZE - 1)));
  }
  const total = heights.reduce((a, b) => a + b, 0);
  rowEdgeT = [0];
  let acc = 0;
  for (let r = 0; r < BOARD_SIZE; r++) {
    acc += heights[r] / total;
    rowEdgeT.push(acc);
  }
  rowEdgeT[BOARD_SIZE] = 1; // exactness against float drift
}

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.min(window.innerWidth, window.innerHeight / 1.28);
  VIEW_W = Math.floor(w);
  HUD_H = Math.floor(VIEW_W * 0.15);
  RAIL = Math.floor(VIEW_W * 0.035);
  BOARD_PX = VIEW_W - RAIL * 2;
  BOARD_H = Math.floor(BOARD_PX * 0.92); // slightly squashed = camera tilt
  TILE = BOARD_PX / BOARD_SIZE;
  BOARD_Y = HUD_H + RAIL;
  const footer = Math.floor(VIEW_W * 0.1);
  VIEW_H = HUD_H + RAIL + BOARD_H + RAIL + footer;

  canvas.style.width = `${VIEW_W}px`;
  canvas.style.height = `${VIEW_H}px`;
  canvas.width = Math.floor(VIEW_W * dpr);
  canvas.height = Math.floor(VIEW_H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  computePerspective();
}
window.addEventListener('resize', resize);
resize();

/** Normalized vertical position (0..1) for a continuous row coordinate 0..8. */
function tAt(rr: number): number {
  const clamped = Math.max(0, Math.min(BOARD_SIZE, rr));
  const r0 = Math.min(BOARD_SIZE - 1, Math.floor(clamped));
  const frac = clamped - r0;
  return rowEdgeT[r0] + (rowEdgeT[r0 + 1] - rowEdgeT[r0]) * frac;
}

/** Board width at normalized depth t (0 = far edge, 1 = near edge). */
function widthAt(t: number): number {
  return BOARD_PX * (FAR_W + (1 - FAR_W) * t);
}

/** Continuous board coords (row 0..8, col 0..8) → screen pixels. */
function rcToXY(rr: number, cc: number): { x: number; y: number } {
  const t = tAt(rr);
  return {
    x: VIEW_W / 2 + (cc - BOARD_SIZE / 2) * (widthAt(t) / BOARD_SIZE),
    y: BOARD_Y + BOARD_H * t,
  };
}

/** Screen pixels → board cell, or null if outside the trapezoid. */
function xyToRC(x: number, y: number): { r: number; c: number } | null {
  const t = (y - BOARD_Y) / BOARD_H;
  if (t < 0 || t > 1) return null;
  let rr = BOARD_SIZE - 1;
  for (let r = 0; r < BOARD_SIZE; r++) {
    if (t <= rowEdgeT[r + 1]) {
      rr = r;
      break;
    }
  }
  const cc = (x - VIEW_W / 2) / (widthAt(t) / BOARD_SIZE) + BOARD_SIZE / 2;
  if (cc < 0 || cc >= BOARD_SIZE) return null;
  return { r: rr, c: Math.floor(cc) };
}

/** Tile width (px) at a row — the depth-scale for entities standing there. */
function tileWidthAt(rr: number): number {
  return widthAt(tAt(rr)) / BOARD_SIZE;
}

/** Trace the quad of cell (r, c) as a path (for fills/strokes/clips). */
function tileQuadPath(r: number, c: number, inset = 0): void {
  const p00 = rcToXY(r + inset, c + inset);
  const p01 = rcToXY(r + inset, c + 1 - inset);
  const p11 = rcToXY(r + 1 - inset, c + 1 - inset);
  const p10 = rcToXY(r + 1 - inset, c + inset);
  ctx.beginPath();
  ctx.moveTo(p00.x, p00.y);
  ctx.lineTo(p01.x, p01.y);
  ctx.lineTo(p11.x, p11.y);
  ctx.lineTo(p10.x, p10.y);
  ctx.closePath();
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

/** A bubble rising through the water volume from deck to surface. */
interface Bubble {
  rr: number; // board row (continuous)
  cc: number; // board col (continuous)
  born: number;
  dur: number;
  size: number;
  phase: number; // wobble offset
}

/** An expanding ripple ring on the water surface. */
interface Ripple {
  rr: number;
  cc: number;
  born: number;
  dur: number;
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
  facing: 1 as 1 | -1,
  move: null as MoveAnim | null,

  hp: START_HP,
  maxSteps: BASE_MAX_STEPS,
  stepsUsed: 0,
  score: 0,
  relic: null as RelicId | null,

  runStart: 0,
  runEnd: null as number | null,
  /** Timestamp of the next chest-deep struggle tick (0 = not struggling yet). */
  nextStruggleAt: 0,

  ending: null as Ending,
  particles: [] as Particle[],
  bubbles: [] as Bubble[],
  ripples: [] as Ripple[],
  shake: { mag: 0, until: 0 },

  submitState: 'idle' as 'idle' | 'sending' | 'done' | 'error',
  submit: null as SubmitData | null,
  submitMsg: '',

  hitboxes: [] as Hitbox[],
};

// ---------------------------------------------------------------------------
// Flood model — the deck fills VERTICALLY, like a room filling with water.
// One global water height rises from the floor the moment gameplay starts and
// tops the survivor's head at FLOOD_TOTAL_S (20s), everywhere at once.
// Chest-deep water makes you struggle (periodic HP loss); head-under is over.
// ---------------------------------------------------------------------------
const WATER_HEAD = 0.9; // tile-units: the survivor's head top — drown height
const WATER_CHEST = 0.45; // tile-units: struggling starts here
const STRUGGLE_PERIOD_MS = 4000; // one HP every 4s while chest-deep

/** Seconds of gameplay elapsed (frozen at game over). */
function runElapsed(now: number): number {
  if (state.phase !== 'playing' && state.phase !== 'gameover') return 0;
  const end = state.runEnd ?? now;
  return Math.max(0, (Math.min(now, end) - state.runStart) / 1000);
}

/** Current water height above the deck, in tile-units (same everywhere). */
function waterHeightTiles(now: number): number {
  return Math.min(WATER_HEAD, (runElapsed(now) / FLOOD_TOTAL_S) * WATER_HEAD);
}

/** Seconds until the water tops the survivor's head. */
function secondsUntilDrown(now: number): number {
  return Math.max(0, FLOOD_TOTAL_S - runElapsed(now));
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
    maybeAutoStart();
  } catch (err) {
    state.error = `Couldn't reach the harbor (${String(err)}). Refresh to retry.`;
    state.phase = 'title';
  }
}
void boot();

/**
 * Dev-only screenshot harness (localhost playtest only): ?auto=1&elapsed=12
 * jumps straight into a practice run with the flood clock pre-advanced, so
 * headless-browser screenshots can capture any moment of the sink. Inert in
 * production — it requires a localhost hostname.
 */
function maybeAutoStart(): void {
  if (window.location.hostname !== 'localhost') return;
  const params = new URLSearchParams(window.location.search);
  if (params.get('auto') !== '1') return;
  startRun(true);
  chooseRelic((params.get('relic') as RelicId | null) ?? 'compass');
  const elapsed = Number(params.get('elapsed') ?? 0);
  state.runStart = performance.now() - elapsed * 1000;
  state.playerR = Number(params.get('r') ?? 3);
  state.playerC = Number(params.get('c') ?? 3);
  state.nextStruggleAt = Number.MAX_SAFE_INTEGER; // hold the pose for the camera
}

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
  state.nextStruggleAt = 0;
  state.ending = null;
  state.particles = [];
  state.bubbles = [];
  state.ripples = [];
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
      const cell = xyToRC(x, y);
      if (!cell) return;
      tryMove(cell.r, cell.c);
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
  state.runStart = performance.now(); // the flood starts NOW — run!
  state.phase = 'playing';
}

function finishMove(): void {
  const mv = state.move!;
  state.move = null;
  state.playerR = mv.toR;
  state.playerC = mv.toC;
  state.stepsUsed += 1;

  resolveTile(mv.toR, mv.toC);

  if (state.hp <= 0) return endRun('drowned');
  if (state.grid![mv.toR][mv.toC] === 'lifeboat') return endRun('escaped');
  if (state.stepsUsed >= state.maxSteps) return endRun('stranded');
}

/**
 * The rising water's pressure on the survivor: once it's chest-deep you're
 * fighting to stay up (1 HP every few seconds), and once it tops your head
 * you drown outright. The only way out is the lifeboat.
 */
function applyWaterPressure(now: number): void {
  if (state.phase !== 'playing') return;
  const h = waterHeightTiles(now);
  if (h >= WATER_HEAD) {
    endRun('drowned');
    return;
  }
  if (h >= WATER_CHEST) {
    if (state.nextStruggleAt === 0) state.nextStruggleAt = now; // first gasp
    if (now >= state.nextStruggleAt) {
      state.nextStruggleAt = now + STRUGGLE_PERIOD_MS;
      const { x, y } = rcToXY(
        Math.round(state.playerR) + 0.5,
        Math.round(state.playerC) + 0.5
      );
      state.hp -= 1;
      sfx('splash');
      burst(x, y, COLORS.breachFoam);
      state.shake = { mag: TILE * 0.15, until: now + 250 };
      if (state.hp <= 0) endRun('drowned');
    }
  }
}

function resolveTile(r: number, c: number): void {
  const grid = state.grid!;
  const tile = grid[r][c];
  const { x: cx, y: cy } = rcToXY(r + 0.5, c + 0.5);

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
      applyWaterPressure(now);
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
  if (t >= 1) finishMove();
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
  ctx.fillText(
    `The deck floods in ${Math.round(FLOOD_TOTAL_S)} seconds. Reach the lifeboat.`,
    VIEW_W / 2,
    VIEW_H * 0.61 + bob
  );

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
  ctx.font = `700 ${Math.floor(VIEW_W * 0.032)}px sans-serif`;
  ctx.fillText(
    `⚠️ The water starts rising the moment you choose — over your head in ${Math.round(FLOOD_TOTAL_S)}s. RUN!`,
    VIEW_W / 2,
    cardY + VIEW_H * 0.055
  );
}

// ---------------------------------------------------------------------------
// Screen: the game.
// Painter's order for the 2.75D look:
//   sea backdrop → hull side → perspective deck tiles → move hints → railing →
//   per-row entities + player (near overlaps far) → flood volume → particles →
//   HUD → practice watermark
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
  drawDeckCaustics(now); // dancing light on the drowned planks (under entities)
  drawRailing();
  drawRefraction(now); // the submerged deck itself wobbles like liquid
  drawEntitiesAndPlayer(now); // water strips are interleaved per row inside
  drawFloodExtras(now); // front wall, meniscus, bubbles, glints, motes
  drawDepthFog(now); // distance-graded darkness — the world sinks toward black
  drawGodRays(now); // moonlight shafts cutting through the risen water
  drawCinematicVignette(now);
  drawParticles(now);

  ctx.restore();

  drawHud(now);

  // A small ribbon instead of a screen-wide watermark — labels the run
  // without wrecking the scene.
  if (state.practice && state.phase === 'playing') {
    ctx.save();
    const rw = VIEW_W * 0.22;
    const rh = VIEW_W * 0.05;
    const rx = VIEW_W - rw - RAIL;
    const ry = HUD_H + RAIL * 0.6;
    ctx.fillStyle = 'rgba(255, 210, 63, 0.85)';
    roundRect(rx, ry, rw, rh, rh / 2);
    ctx.fill();
    ctx.fillStyle = '#2b1206';
    ctx.font = `800 ${Math.floor(rh * 0.55)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PRACTICE', rx + rw / 2, ry + rh / 2 + 0.5);
    ctx.restore();
  }
}

/** The hull cross-section below the near edge of the deck. */
function drawHullSide(now: number): void {
  const nearL = rcToXY(BOARD_SIZE, 0);
  const nearR = rcToXY(BOARD_SIZE, BOARD_SIZE);
  const y = nearL.y + RAIL;
  const h = VIEW_H - y;
  ctx.fillStyle = COLORS.hullSide;
  ctx.beginPath();
  ctx.moveTo(nearL.x - RAIL, y);
  ctx.lineTo(nearR.x + RAIL, y);
  ctx.lineTo(nearR.x - RAIL * 0.6, y + h);
  ctx.lineTo(nearL.x + RAIL * 0.6, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(127, 212, 255, 0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = nearL.x - RAIL; x <= nearR.x + RAIL; x += 10) {
    const wy = y + h * 0.5 + Math.sin(x / 26 + now / 300) * 4;
    if (x === nearL.x - RAIL) ctx.moveTo(x, wy);
    else ctx.lineTo(x, wy);
  }
  ctx.stroke();
}

/** Perspective deck tiles: each cell is a trapezoid quad with bevel strips. */
function drawDeck(now: number): void {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      // Base plank fill.
      ctx.fillStyle = (r + c) % 2 === 0 ? COLORS.deckLight : COLORS.deckDark;
      tileQuadPath(r, c);
      ctx.fill();

      // Bevel: light strip near the far edge, dark strip near the near edge.
      const q00 = rcToXY(r, c);
      const q01 = rcToXY(r, c + 1);
      const b00 = rcToXY(r + 0.12, c);
      const b01 = rcToXY(r + 0.12, c + 1);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.beginPath();
      ctx.moveTo(q00.x, q00.y);
      ctx.lineTo(q01.x, q01.y);
      ctx.lineTo(b01.x, b01.y);
      ctx.lineTo(b00.x, b00.y);
      ctx.closePath();
      ctx.fill();

      const d00 = rcToXY(r + 0.88, c);
      const d01 = rcToXY(r + 0.88, c + 1);
      const q10 = rcToXY(r + 1, c);
      const q11 = rcToXY(r + 1, c + 1);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
      ctx.beginPath();
      ctx.moveTo(d00.x, d00.y);
      ctx.lineTo(d01.x, d01.y);
      ctx.lineTo(q11.x, q11.y);
      ctx.lineTo(q10.x, q10.y);
      ctx.closePath();
      ctx.fill();

      // Plank seam + outline.
      const m0 = rcToXY(r + 0.5, c);
      const m1 = rcToXY(r + 0.5, c + 1);
      ctx.strokeStyle = COLORS.deckSeam;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(m0.x, m0.y);
      ctx.lineTo(m1.x, m1.y);
      ctx.stroke();
      tileQuadPath(r, c);
      ctx.stroke();
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
      tileQuadPath(r, c);
      ctx.fill();
    }
  }
}

/** Railing drawn in perspective along the trapezoid's edges. */
function drawRailing(): void {
  const farL = rcToXY(0, 0);
  const farR = rcToXY(0, BOARD_SIZE);
  const nearL = rcToXY(BOARD_SIZE, 0);
  const nearR = rcToXY(BOARD_SIZE, BOARD_SIZE);
  const railFar = RAIL * FAR_W; // far rail is thinner (depth cue)

  ctx.fillStyle = COLORS.railWood;
  // Far rail.
  ctx.fillRect(farL.x - railFar, farL.y - railFar, farR.x - farL.x + railFar * 2, railFar);
  // Near rail.
  ctx.fillRect(nearL.x - RAIL, nearL.y, nearR.x - nearL.x + RAIL * 2, RAIL);
  // Slanted side rails (quads following the perspective edges).
  ctx.beginPath();
  ctx.moveTo(farL.x - railFar, farL.y - railFar);
  ctx.lineTo(farL.x, farL.y);
  ctx.lineTo(nearL.x, nearL.y + RAIL);
  ctx.lineTo(nearL.x - RAIL, nearL.y + RAIL);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(farR.x + railFar, farR.y - railFar);
  ctx.lineTo(farR.x, farR.y);
  ctx.lineTo(nearR.x, nearR.y + RAIL);
  ctx.lineTo(nearR.x + RAIL, nearR.y + RAIL);
  ctx.closePath();
  ctx.fill();

  // Posts along the far rail.
  ctx.fillStyle = COLORS.railWoodDark;
  for (let i = 0; i <= BOARD_SIZE; i++) {
    const p = rcToXY(0, i);
    ctx.fillRect(p.x - railFar * 0.15, p.y - railFar * 0.85, railFar * 0.3, railFar * 0.7);
  }

  // Inner lip around the deck.
  ctx.strokeStyle = COLORS.railWoodDark;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(farL.x, farL.y);
  ctx.lineTo(farR.x, farR.y);
  ctx.lineTo(nearR.x, nearR.y);
  ctx.lineTo(nearL.x, nearL.y);
  ctx.closePath();
  ctx.stroke();
}

/**
 * Entities + player, painted row by row so near overlaps far, each drawn in
 * its own translated + depth-scaled frame (origin = tile center, TILE units).
 */
function drawEntitiesAndPlayer(now: number): void {
  const grid = state.grid!;
  const playerRow = state.playerR;
  // Buoyancy: pearls, crates, sharks and the lifeboat FLOAT — they visibly
  // ride UP with the surface as the deck fills (in the entity's local
  // tile-units the surface height IS the water height). Watching loot lift
  // off the deck is the strongest "the level is rising" cue on screen.
  const lift = waterHeightTiles(now) * TILE;

  const drawAt = (r: number, c: number, fn: () => void, dy = 0): void => {
    const { x, y } = rcToXY(r + 0.5, c + 0.5);
    const k = tileWidthAt(r + 0.5) / TILE; // depth scale
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.translate(0, dy);
    fn();
    ctx.restore();
  };

  for (let r = 0; r < BOARD_SIZE; r++) {
    // 1. Deck-bound things that get submerged: breaches and the survivor.
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (grid[r][c] === 'breach') drawAt(r, c, () => drawBreach(now));
    }
    if (Math.round(playerRow) === r) drawPlayer(now);

    // 2. This row's slice of the rising water — covers the deck-bound.
    drawWaterRowStrip(r, now);
    drawUnderwaterGridRow(r, now); // keeps tiles readable as the wood drowns

    // 3. Buoyant things, ON TOP of the surface. Their contact shadows stay
    //    ON THE DECK and fade as they rise — the widening gap between sprite
    //    and shadow makes the climbing level readable on every single tile.
    const liftFrac = Math.min(1, waterHeightTiles(now) / WATER_HEAD);
    const foamA = Math.min(1, (lift / TILE) / 0.2) * 0.5;
    const floatDraw = (fr: number, fc: number, shadowW: number, fn: () => void, liftMul = 1): void => {
      ctx.save();
      ctx.globalAlpha = Math.max(0.15, 1 - 0.6 * liftFrac);
      drawAt(fr, fc, () => shadow(shadowW));
      ctx.restore();
      drawAt(
        fr,
        fc,
        () => {
          fn();
          // Foam ring where the floater sits in the surface.
          if (foamA > 0.04) {
            ctx.strokeStyle = `rgba(235, 250, 255, ${foamA.toFixed(3)})`;
            ctx.lineWidth = Math.max(1.2, TILE * 0.028);
            ctx.beginPath();
            ctx.ellipse(0, TILE * 0.3, shadowW * 1.25, shadowW * 0.42, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
        },
        -lift * liftMul
      );
    };
    for (let c = 0; c < BOARD_SIZE; c++) {
      switch (grid[r][c]) {
        case 'pearl':
          floatDraw(r, c, TILE * 0.2, () => drawPearl(now));
          break;
        case 'crate':
          floatDraw(r, c, TILE * 0.29, () => drawCrate(now));
          break;
        case 'shark':
          // A shark swims: body just under the surface, fin above it.
          floatDraw(r, c, TILE * 0.31, () => drawShark(now), 0.85);
          break;
        case 'lifeboat':
          floatDraw(r, c, TILE * 0.34, () => drawLifeboat(now));
          break;
        default:
          break;
      }
    }
  }
}

/** Elliptical contact shadow (origin-relative, TILE units). */
function shadow(w: number, dy = TILE * 0.3): void {
  ctx.fillStyle = COLORS.shadow;
  ctx.beginPath();
  ctx.ellipse(0, dy, w, w * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
}

// --- Entity primitives — all origin-relative so depth-scaling is one scale()

function drawPearl(now: number): void {
  const bob = Math.sin(now / 400) * TILE * 0.05;
  const rad = TILE * 0.2;
  const py = TILE * 0.05 - bob;
  glowHalo(now, '159, 232, 255', TILE * 0.5, 0.55); // deep-water bioluminescence

  ctx.fillStyle = '#d8b78f';
  ctx.beginPath();
  ctx.ellipse(0, TILE * 0.22, rad * 1.35, rad * 0.55, 0, 0, Math.PI);
  ctx.fill();

  const g = ctx.createRadialGradient(-rad * 0.3, py - rad * 0.3, rad * 0.2, 0, py, rad);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.5, COLORS.pearl);
  g.addColorStop(1, COLORS.pearlCore);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, py, rad, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(-rad * 0.35, py - rad * 0.35, rad * 0.2, 0, Math.PI * 2);
  ctx.fill();
}

function drawCrate(now: number): void {
  const s = TILE * 0.52;
  const topH = s * 0.38;
  const x = -s / 2;
  const frontY = -TILE * 0.02;
  glowHalo(now, '255, 210, 63', TILE * 0.5, 0.5); // deep-water bioluminescence

  ctx.fillStyle = COLORS.crateFront;
  ctx.fillRect(x, frontY, s, TILE * 0.32);
  ctx.fillStyle = COLORS.crateTop;
  ctx.beginPath();
  ctx.moveTo(x, frontY);
  ctx.lineTo(x + s * 0.14, frontY - topH);
  ctx.lineTo(x + s + s * 0.14, frontY - topH);
  ctx.lineTo(x + s, frontY);
  ctx.closePath();
  ctx.fill();

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

function drawShark(now: number): void {
  const sway = Math.sin(now / 300) * TILE * 0.05;
  const bodyR = TILE * 0.28;
  glowHalo(now, '255, 97, 97', TILE * 0.55, 0.4); // danger reads red in the dark
  ctx.save();
  ctx.translate(sway, TILE * 0.02);

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

function drawBreach(now: number): void {
  const spin = now / 600;
  const spikes = 9;
  const outer = TILE * 0.3;
  const inner = TILE * 0.15;
  glowHalo(now, '127, 212, 255', TILE * 0.5, 0.35); // deep-water bioluminescence
  ctx.fillStyle = 'rgba(4, 18, 30, 0.45)';
  ctx.beginPath();
  ctx.ellipse(0, TILE * 0.06, outer * 1.25, outer * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
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

function drawLifeboat(now: number): void {
  const bob = Math.sin(now / 350) * TILE * 0.03;
  const w = TILE * 0.68;
  const h = TILE * 0.34;

  // The beacon burns brightest in the deep — your way out.
  glowHalo(now, '255, 107, 61', TILE * 0.75, 0.65);
  const pulse = 0.5 + 0.5 * Math.sin(now / 350);
  const glow = ctx.createRadialGradient(0, 0, TILE * 0.1, 0, 0, TILE * 0.55);
  glow.addColorStop(0, `rgba(255, 107, 61, ${0.25 + pulse * 0.2})`);
  glow.addColorStop(1, 'rgba(255, 107, 61, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(-TILE * 0.55, -TILE * 0.55, TILE * 1.1, TILE * 1.1);

  ctx.save();
  ctx.translate(0, bob);

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

/** The survivor — drawn at their (possibly mid-lerp) position, depth-scaled. */
function drawPlayer(now: number): void {
  const { x, y } = rcToXY(state.playerR + 0.5, state.playerC + 0.5);
  const k = tileWidthAt(state.playerR + 0.5) / TILE;

  let hop = 0;
  if (state.move) {
    const t = Math.min(1, (now - state.move.start) / MOVE_MS);
    hop = Math.sin(t * Math.PI) * TILE * 0.14;
  } else {
    hop = Math.max(0, Math.sin(now / 350)) * TILE * 0.02;
  }

  const headR = TILE * 0.14;
  const bodyW = TILE * 0.3;
  const bodyH = TILE * 0.26;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);

  // Always-on rim light so the survivor never disappears into the water,
  // plus the deep-water glow that ramps as the world darkens.
  const rim = ctx.createRadialGradient(0, -TILE * 0.1, TILE * 0.08, 0, -TILE * 0.1, TILE * 0.42);
  rim.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
  rim.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = rim;
  ctx.fillRect(-TILE * 0.42, -TILE * 0.52, TILE * 0.84, TILE * 0.84);
  glowHalo(now, '47, 168, 255', TILE * 0.65, 0.55); // find yourself in the dark
  shadow(TILE * 0.2 * (1 - hop / TILE));
  ctx.translate(0, -hop);
  ctx.scale(state.facing, 1);

  const step = state.move ? Math.sin(now / 40) * TILE * 0.04 : 0;
  ctx.fillStyle = COLORS.pants;
  ctx.fillRect(-bodyW * 0.32, TILE * 0.12 + step, bodyW * 0.26, TILE * 0.14);
  ctx.fillRect(bodyW * 0.06, TILE * 0.12 - step, bodyW * 0.26, TILE * 0.14);

  ctx.fillStyle = COLORS.shirt;
  roundRect(-bodyW / 2, -bodyH * 0.4, bodyW, bodyH, bodyW * 0.25);
  ctx.fill();
  ctx.fillStyle = COLORS.vest;
  roundRect(-bodyW / 2, -bodyH * 0.4, bodyW, bodyH * 0.62, bodyW * 0.25);
  ctx.fill();
  ctx.strokeStyle = COLORS.lifeboatTrim;
  ctx.lineWidth = Math.max(1.5, TILE * 0.025);
  ctx.beginPath();
  ctx.moveTo(-bodyW * 0.28, -bodyH * 0.28);
  ctx.lineTo(bodyW * 0.28, -bodyH * 0.05);
  ctx.stroke();

  ctx.fillStyle = COLORS.skin;
  ctx.beginPath();
  ctx.arc(0, -bodyH * 0.4 - headR * 0.9, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#20303c';
  ctx.beginPath();
  ctx.arc(headR * 0.42, -bodyH * 0.4 - headR, headR * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5b4426';
  ctx.beginPath();
  ctx.arc(0, -bodyH * 0.4 - headR * 1.15, headR * 0.85, Math.PI, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // --- Submersion overlay: THE "water is rising" shot -----------------------
  // Water drawn ON the survivor, from the feet up to the current waterline,
  // with a foam ring lapping around the body. As the global level climbs you
  // watch this line travel up their legs, chest, and finally over their head.
  // (Drawn in the un-hopped frame so the waterline stays put while they jump.)
  const h = waterHeightTiles(now); // tile-units
  if (h > 0.03) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    const yDeckLocal = TILE * 0.3; // the deck plane at the feet
    const yLine = yDeckLocal - h * TILE; // local waterline height
    // Soft water tint over the submerged part of the body — a radial blob
    // that fades at the edges (no hard box), just enough to sink the sprite.
    const midY = (yLine + yDeckLocal) / 2;
    const half = (yDeckLocal - yLine) / 2 + TILE * 0.08;
    ctx.save();
    ctx.translate(0, midY);
    ctx.scale(1, Math.max(0.2, half / (TILE * 0.5)));
    const blob = ctx.createRadialGradient(0, 0, TILE * 0.08, 0, 0, TILE * 0.5);
    blob.addColorStop(0, 'rgba(16, 90, 132, 0.55)');
    blob.addColorStop(0.75, 'rgba(16, 90, 132, 0.35)');
    blob.addColorStop(1, 'rgba(16, 90, 132, 0)');
    ctx.fillStyle = blob;
    ctx.beginPath();
    ctx.arc(0, 0, TILE * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Foam lapping around them at the waterline.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = Math.max(1.5, TILE * 0.035);
    ctx.beginPath();
    const lap = Math.sin(now / 240) * TILE * 0.015;
    ctx.ellipse(0, yLine + lap, TILE * 0.34, TILE * 0.09, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Exhaled air once they're going under — a thin trail of bubbles racing
    // for the surface.
    if (h > 0.55) {
      ctx.fillStyle = 'rgba(220, 245, 255, 0.55)';
      for (let i = 0; i < 3; i++) {
        const p = (now / 900 + i * 0.33) % 1;
        const from = -TILE * 0.2;
        const to = yLine - TILE * 0.1;
        if (to >= from) continue;
        const bx = Math.sin(now / 200 + i * 2.1) * TILE * 0.07;
        const by = from + (to - from) * p;
        ctx.beginPath();
        ctx.arc(bx, by, TILE * (0.014 + 0.02 * p), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

/**
 * The flood — ONE horizontal water surface across the whole deck, rising
 * VERTICALLY from the floor like a room filling up. Every tile shares the
 * same water height h; each row's slice of the surface is that row's deck
 * plane LIFTED by h (scaled to the row's perspective size so the plane
 * recedes toward the vanishing point). Characters sink from the feet up:
 * whatever stands taller than h pokes out crisp above the surface, the rest
 * shows tinted through the translucent fill (each row's occupants are painted
 * just before that row's water strip — see drawEntitiesAndPlayer).
 */

/** Water depth in screen px above the deck at row coordinate rr. */
function waterDepthPx(rr: number, now: number): number {
  // Scale with the row's perspective size so far water looks far.
  return waterHeightTiles(now) * tileWidthAt(rr);
}

/** Screen y of the water SURFACE at row coordinate rr (deck minus depth). */
function waterSurfaceY(rr: number, now: number): number {
  return BOARD_Y + BOARD_H * tAt(rr) - waterDepthPx(rr, now);
}

/** Left/right x of the water sheet (board edge + submerged rail) at rr. */
function waterXL(rr: number): number {
  return VIEW_W / 2 - widthAt(tAt(rr)) / 2 - RAIL * (FAR_W + (1 - FAR_W) * tAt(rr));
}
function waterXR(rr: number): number {
  return VIEW_W / 2 + widthAt(tAt(rr)) / 2 + RAIL * (FAR_W + (1 - FAR_W) * tAt(rr));
}

/** 0 → shallow … 1 → water at head height: drives the deep-water effects. */
function depthGlow(now: number): number {
  const h = waterHeightTiles(now);
  return Math.max(0, Math.min(1, (h - WATER_CHEST) / (WATER_HEAD - WATER_CHEST)));
}

/**
 * Bioluminescent halo behind an entity once the deck is deep underwater.
 * The world darkens as it sinks, so everything that matters starts to GLOW —
 * the last seconds stay readable and look properly abyssal. Drawn in the
 * entity's local frame, centered on the origin.
 */
function glowHalo(now: number, rgb: string, radius: number, strength = 0.5): void {
  const g = depthGlow(now);
  if (g <= 0.02) return;
  const pulse = 0.75 + 0.25 * Math.sin(now / 300 + radius);
  const a = strength * g * pulse;
  const grad = ctx.createRadialGradient(0, 0, radius * 0.12, 0, 0, radius);
  grad.addColorStop(0, `rgba(${rgb}, ${a.toFixed(3)})`);
  grad.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
}

// ===========================================================================
//  WATER FX SUITE — cinematic three-act sink
//  Act I  (0–35%):  a glassy teal film, glints skating across the surface
//  Act II (35–65%): heavy ocean volume, caustics dancing on the drowned deck
//  Act III (65%+):  black abyss cut by god-rays, lit by bioluminescence
// ===========================================================================

/** Three-octave surface wave: slow swell + medium chop + fast ripple. */
function waveAt(rr: number, now: number): number {
  return (
    (Math.sin(now / 1400 + rr * 0.9) * 0.62 +
      Math.sin(now / 620 + rr * 1.9) * 0.5 +
      Math.sin(now / 240 + rr * 3.7) * 0.28) *
    TILE *
    0.028
  );
}

/** The animated surface height at rr — deck plane lifted by level + wave. */
function liveSurfaceY(rr: number, now: number): number {
  return waterSurfaceY(rr, now) + waveAt(rr, now);
}

/** Linear mix of two RGB triples, as a CSS color with the given alpha. */
function mixRgba(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
  alpha: number
): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgba(${r}, ${g}, ${bl}, ${alpha.toFixed(3)})`;
}

const WATER_NEAR: readonly [number, number, number] = [40, 160, 205]; // lagoon
const WATER_FAR: readonly [number, number, number] = [8, 52, 88]; // abyss

/**
 * One row's slice of the global water surface. Called from
 * drawEntitiesAndPlayer IMMEDIATELY after that row's occupants so occlusion
 * is correct: the water visibly climbs each character's body from the floor,
 * and nearer rows' strips overlap from the front. Color is distance-fogged
 * (near = lagoon teal, far = abyssal navy) and density grows with the level.
 */
function drawWaterRowStrip(r: number, now: number): void {
  const h = waterHeightTiles(now);
  if (h <= 0) return;

  // Starts as a barely-there film, then the water WINS the floor: by the
  // deep phase it is nearly opaque and the wood is gone — the glowing
  // underwater grid (drawn right after each strip) keeps the board playable.
  const alpha = Math.min(0.86, 0.06 + 0.8 * Math.pow(Math.min(1, h / WATER_HEAD), 1.2));
  const S = 4;
  for (let i = 0; i < S; i++) {
    const rr0 = r + i / S;
    const rr1 = r + (i + 1) / S;
    // Distance fog: farther slices read darker and colder.
    ctx.fillStyle = mixRgba(WATER_NEAR, WATER_FAR, 1 - tAt((rr0 + rr1) / 2), alpha);
    ctx.beginPath();
    ctx.moveTo(waterXL(rr0), liveSurfaceY(rr0, now));
    ctx.lineTo(waterXR(rr0), liveSurfaceY(rr0, now));
    ctx.lineTo(waterXR(rr1), liveSurfaceY(rr1, now));
    ctx.lineTo(waterXL(rr1), liveSurfaceY(rr1, now));
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * As the water turns opaque and the wood disappears, a faint cyan grid glows
 * through from the drowned deck so the game stays perfectly playable — and it
 * doubles as a depth cue: grid fading in = wood going under.
 */
function drawUnderwaterGridRow(r: number, now: number): void {
  const h = waterHeightTiles(now);
  const a = Math.max(0, Math.min(1, (h - 0.28) / 0.55)) * 0.24;
  if (a <= 0.01) return;
  ctx.strokeStyle = `rgba(140, 220, 255, ${a.toFixed(3)})`;
  ctx.lineWidth = 1;
  for (let c = 0; c < BOARD_SIZE; c++) {
    tileQuadPath(r, c);
    ctx.stroke();
  }
}

/**
 * Screen-space refraction: re-blit the just-drawn deck in thin horizontal
 * slices, each displaced sideways by interfering sine waves whose amplitude
 * grows with the water level. The BOARD ITSELF visibly wavers like it's under
 * moving water — the single strongest "this whole surface is submerged" cue.
 */
function drawRefraction(now: number): void {
  const h = waterHeightTiles(now);
  if (h <= 0.04) return;
  const dpr = canvas.width / VIEW_W;
  const top = BOARD_Y - RAIL;
  const bottom = BOARD_Y + BOARD_H;
  const slices = 30;
  const sliceH = (bottom - top) / slices;
  const strength = Math.min(1, h / 0.5); // ramps in over the first half
  for (let i = 0; i < slices; i++) {
    const sy = top + i * sliceH;
    const off =
      (Math.sin(now / 420 + i * 0.55) + Math.sin(now / 260 - i * 0.35) * 0.5) *
      TILE *
      0.035 *
      strength;
    ctx.drawImage(
      canvas,
      0,
      sy * dpr,
      canvas.width,
      Math.max(1, sliceH * dpr),
      off,
      sy,
      VIEW_W,
      sliceH
    );
  }
}

/**
 * Caustic light dancing on the submerged deck — two interfering wave lattices
 * drawn UNDER the entities, clipped to the board trapezoid. The classic
 * "swimming-pool floor" shimmer that instantly reads as water over wood.
 */
function drawDeckCaustics(now: number): void {
  const h = waterHeightTiles(now);
  if (h <= 0.02) return;

  const farL = rcToXY(0, 0);
  const farR = rcToXY(0, BOARD_SIZE);
  const nearL = rcToXY(BOARD_SIZE, 0);
  const nearR = rcToXY(BOARD_SIZE, BOARD_SIZE);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(farL.x, farL.y);
  ctx.lineTo(farR.x, farR.y);
  ctx.lineTo(nearR.x, nearR.y);
  ctx.lineTo(nearL.x, nearL.y);
  ctx.closePath();
  ctx.clip();
  ctx.globalCompositeOperation = 'overlay';

  const strength = 0.12 + 0.16 * Math.min(1, h / WATER_HEAD);
  const bands = 9;
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = `rgba(168, 228, 255, ${(strength * (pass === 0 ? 1 : 0.7)).toFixed(3)})`;
    ctx.lineWidth = pass === 0 ? 1.6 : 1.1;
    for (let j = 0; j < bands; j++) {
      const y0 = BOARD_Y + (BOARD_H * (j + 0.5)) / bands;
      ctx.beginPath();
      let first = true;
      for (let x = nearL.x; x <= nearR.x; x += 14) {
        const y =
          y0 +
          (pass === 0
            ? Math.sin(x / 34 + now / 450 + j * 1.8) * 5
            : Math.sin(x / 21 - now / 380 + j * 2.6) * 4);
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * After all rows: the water's FRONT FACE (the cross-section that visibly
 * grows), its glowing meniscus, rising bubble streams, specular glints, and
 * drifting motes. The set-dressing that makes the volume feel alive.
 */
function drawFloodExtras(now: number): void {
  const h = waterHeightTiles(now);
  if (h <= 0) return;

  // --- Front face: the growing cross-section wall -------------------------
  const xl = waterXL(BOARD_SIZE);
  const xr = waterXR(BOARD_SIZE);
  const ySurf = liveSurfaceY(BOARD_SIZE, now);
  const yDeckNear = BOARD_Y + BOARD_H + RAIL;
  const wall = ctx.createLinearGradient(0, ySurf, 0, yDeckNear);
  wall.addColorStop(0, 'rgba(94, 205, 255, 0.95)');
  wall.addColorStop(0.3, 'rgba(32, 138, 190, 0.92)');
  wall.addColorStop(1, 'rgba(4, 40, 70, 0.96)');
  ctx.fillStyle = wall;
  ctx.fillRect(xl, ySurf, xr - xl, Math.max(0, yDeckNear - ySurf));

  // Light streaks shimmering inside the wall — the fish-tank cross-section.
  if (yDeckNear - ySurf > 6) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(xl, ySurf, xr - xl, yDeckNear - ySurf);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 9; i++) {
      const sx = xl + ((i + 0.5) / 9) * (xr - xl) + Math.sin(now / 700 + i * 2.4) * TILE * 0.12;
      const sw = TILE * (0.03 + 0.03 * hash01(i + 77));
      const sa = 0.06 + 0.05 * Math.sin(now / 500 + i * 1.3);
      if (sa <= 0.02) continue;
      const sg = ctx.createLinearGradient(0, ySurf, 0, yDeckNear);
      sg.addColorStop(0, `rgba(180, 235, 255, ${sa.toFixed(3)})`);
      sg.addColorStop(1, 'rgba(180, 235, 255, 0)');
      ctx.fillStyle = sg;
      ctx.fillRect(sx - sw / 2, ySurf, sw, yDeckNear - ySurf);
    }
    ctx.restore();
  }

  // --- Meniscus: the glowing waterline you watch climb ---------------------
  const meniscus = (y0: number, x0: number, x1: number, strength: number): void => {
    ctx.save();
    ctx.shadowColor = `rgba(159, 232, 255, ${(0.9 * strength).toFixed(3)})`;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = `rgba(235, 251, 255, ${(0.95 * strength).toFixed(3)})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let first = true;
    for (let x = x0; x <= x1; x += 8) {
      const y =
        y0 + Math.sin(x / 24 + now / 300) * TILE * 0.03 + Math.sin(x / 9 - now / 210) * TILE * 0.012;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    // Refraction underline: a soft cyan echo just beneath the crest.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(127, 212, 255, ${(0.35 * strength).toFixed(3)})`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    first = true;
    for (let x = x0; x <= x1; x += 8) {
      const y =
        y0 +
        TILE * 0.045 +
        Math.sin(x / 24 + now / 300) * TILE * 0.03 +
        Math.sin(x / 9 - now / 210) * TILE * 0.012;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  };
  meniscus(ySurf, xl, xr, 1);
  meniscus(liveSurfaceY(0, now), waterXL(0), waterXR(0), 0.45);

  drawRailFoam(now, h);
  drawWaveSparkles(now, h);
  updateAndDrawRipples(now, h);
  updateAndDrawBubbles(now, h);
  drawSurfaceGlints(now, h);
  drawMotes(now);
}

/**
 * The classic cartoon-water read: chunky drifting wave glints (small arcs)
 * scattered across the ENTIRE surface. This is what makes the floor itself
 * scream "water" at a glance — density and brightness climb with the level.
 */
function drawWaveSparkles(now: number, h: number): void {
  const vis = Math.min(1, h / 0.25) * (0.55 + 0.45 * Math.min(1, h / WATER_HEAD));
  if (vis <= 0.03) return;
  for (let i = 0; i < 42; i++) {
    const speed = 0.25 + 0.5 * hash01(i + 11);
    const rr = (hash01(i) * BOARD_SIZE + (now / 7000) * speed * BOARD_SIZE) % BOARD_SIZE;
    const cc = (hash01(i + 91) * BOARD_SIZE + (now / 11000) * BOARD_SIZE * 0.35) % BOARD_SIZE;
    const tw = tileWidthAt(rr);
    const x = VIEW_W / 2 + (cc - BOARD_SIZE / 2) * (widthAt(tAt(rr)) / BOARD_SIZE);
    const y = liveSurfaceY(rr, now);
    const flick = 0.5 + 0.5 * Math.sin(now / 600 + i * 2.1);
    const a = vis * (0.16 + 0.3 * flick);
    if (a < 0.04) continue;
    const w = tw * (0.13 + 0.12 * hash01(i + 31));
    ctx.strokeStyle = `rgba(215, 245, 255, ${a.toFixed(3)})`;
    ctx.lineWidth = Math.max(1.3, tw * 0.05);
    ctx.beginPath();
    ctx.arc(x, y, w, Math.PI * 0.12, Math.PI * 0.88); // the little "wave smile"
    ctx.stroke();
  }
}

/**
 * Foam where the water meets the ship's sides — the surface boundary is
 * outlined in white all the way around the board, not just at the front.
 */
function drawRailFoam(now: number, h: number): void {
  const a = Math.min(1, h / 0.18) * 0.42;
  if (a <= 0.03) return;
  ctx.strokeStyle = `rgba(240, 252, 255, ${a.toFixed(3)})`;
  ctx.lineWidth = 2;
  for (const side of [-1, 1] as const) {
    ctx.beginPath();
    let first = true;
    const N = 16;
    for (let i = 0; i <= N; i++) {
      const rr = (i / N) * BOARD_SIZE;
      const x = VIEW_W / 2 + side * (widthAt(tAt(rr)) / 2);
      const y = liveSurfaceY(rr, now) + Math.sin(now / 260 + rr * 2.4 + side) * TILE * 0.015;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
}

/**
 * Ripple rings blooming at random spots across the WHOLE surface — perspective
 * -squashed expanding ellipses that fade as they grow. Liquid activity on the
 * board itself, not just at its edges.
 */
function updateAndDrawRipples(now: number, h: number): void {
  if (state.phase === 'playing' && h > 0.05 && state.ripples.length < 8 && Math.random() < 0.12) {
    state.ripples.push({
      rr: Math.random() * BOARD_SIZE,
      cc: Math.random() * BOARD_SIZE,
      born: now,
      dur: 1100 + Math.random() * 700,
    });
  }

  state.ripples = state.ripples.filter((rp) => now - rp.born < rp.dur);
  for (const rp of state.ripples) {
    const p = (now - rp.born) / rp.dur;
    const tw = tileWidthAt(rp.rr);
    const x = VIEW_W / 2 + (rp.cc - BOARD_SIZE / 2) * (widthAt(tAt(rp.rr)) / BOARD_SIZE);
    const y = liveSurfaceY(rp.rr, now);
    const rx = tw * (0.12 + 0.6 * p);
    ctx.strokeStyle = `rgba(220, 245, 255, ${((1 - p) * 0.4).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, 2.2 * (1 - p));
    ctx.beginPath();
    ctx.ellipse(x, y, rx, rx * 0.35, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Inner echo ring for the fresh ripples.
    if (p < 0.55) {
      ctx.strokeStyle = `rgba(220, 245, 255, ${((0.55 - p) * 0.35).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, rx * 0.55, rx * 0.19, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** Deterministic 0..1 hash for stable pseudo-random FX placement. */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Bubble streams: seeded at random tiles, they rise from the drowned deck to
 * the surface with a sinusoidal wobble, growing and brightening, then vanish
 * at the meniscus. Constant quiet motion that makes the volume read as LIQUID.
 */
function updateAndDrawBubbles(now: number, h: number): void {
  if (state.phase === 'playing' && h > 0.08 && state.bubbles.length < 16 && Math.random() < 0.2) {
    state.bubbles.push({
      rr: Math.random() * BOARD_SIZE,
      cc: Math.random() * BOARD_SIZE,
      born: now,
      dur: 1600 + Math.random() * 1400,
      size: TILE * (0.02 + Math.random() * 0.03),
      phase: Math.random() * Math.PI * 2,
    });
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  state.bubbles = state.bubbles.filter((b) => now - b.born < b.dur);
  for (const b of state.bubbles) {
    const p = (now - b.born) / b.dur;
    const deckY = BOARD_Y + BOARD_H * tAt(b.rr);
    const surfY = liveSurfaceY(b.rr, now);
    const y = deckY + (surfY - deckY) * p;
    const x =
      VIEW_W / 2 +
      (b.cc - BOARD_SIZE / 2) * (widthAt(tAt(b.rr)) / BOARD_SIZE) +
      Math.sin(now / 260 + b.phase) * TILE * 0.04;
    ctx.strokeStyle = `rgba(220, 245, 255, ${(0.15 + 0.3 * p).toFixed(3)})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, b.size * (0.7 + 0.5 * p), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Specular glints — sparks of moonlight skating on the surface plane. */
function drawSurfaceGlints(now: number, h: number): void {
  const vis = Math.min(1, h / 0.3);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 14; i++) {
    const rr = hash01(i) * BOARD_SIZE;
    const cc = hash01(i + 57) * BOARD_SIZE;
    const flicker = Math.pow(Math.max(0, Math.sin(now / (160 + i * 7) + i * 2.3)), 4) * vis;
    if (flicker < 0.03) continue;
    const tw = tileWidthAt(rr);
    const x = VIEW_W / 2 + (cc - BOARD_SIZE / 2) * (widthAt(tAt(rr)) / BOARD_SIZE);
    const y = liveSurfaceY(rr, now);
    ctx.fillStyle = `rgba(201, 241, 255, ${(0.5 * flicker).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, tw * 0.16 * (0.6 + 0.4 * flicker), tw * 0.02 + 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Drifting motes in the deep-water light — plankton in the beams. */
function drawMotes(now: number): void {
  const g = depthGlow(now);
  if (g <= 0.05) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 16; i++) {
    const rr = (hash01(i + 200) * BOARD_SIZE + now / 9000) % BOARD_SIZE;
    const cc = (hash01(i + 300) * BOARD_SIZE + Math.sin(now / 4000 + i) * 0.3 + BOARD_SIZE) % BOARD_SIZE;
    const deckY = BOARD_Y + BOARD_H * tAt(rr);
    const surfY = liveSurfaceY(rr, now);
    const y = surfY + (deckY - surfY) * hash01(i + 400);
    const x = VIEW_W / 2 + (cc - BOARD_SIZE / 2) * (widthAt(tAt(rr)) / BOARD_SIZE);
    const a = 0.12 * g * (0.5 + 0.5 * Math.sin(now / 700 + i * 1.7));
    ctx.fillStyle = `rgba(190, 235, 255, ${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, 1 + hash01(i + 500) * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Depth fog — distance-graded, not flat: the far (stern) end of the drowned
 * deck vanishes first, exactly like looking down a flooding corridor.
 */
function drawDepthFog(now: number): void {
  const h = waterHeightTiles(now);
  if (h <= 0) return;
  const f = Math.pow(h / WATER_HEAD, 1.3);
  const g = ctx.createLinearGradient(0, HUD_H, 0, VIEW_H);
  g.addColorStop(0, `rgba(2, 14, 28, ${(0.65 * f).toFixed(3)})`);
  g.addColorStop(0.55, `rgba(2, 14, 28, ${(0.35 * f).toFixed(3)})`);
  g.addColorStop(1, `rgba(3, 18, 34, ${(0.45 * f).toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, HUD_H, VIEW_W, VIEW_H - HUD_H);
}

/**
 * God-rays: shafts of moonlight refracting down through the risen water,
 * swaying slowly. Screen-composited so they cut through the depth fog.
 */
function drawGodRays(now: number): void {
  const h = waterHeightTiles(now);
  const f = Math.max(0, Math.min(1, (h - 0.25) / (WATER_HEAD - 0.25)));
  if (f <= 0.02) return;

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 5; i++) {
    const baseX = VIEW_W * (0.1 + 0.2 * i) + Math.sin(now / 2800 + i * 1.7) * VIEW_W * 0.03;
    const breath = 0.7 + 0.3 * Math.sin(now / 1900 + i * 2.2);
    const wTop = VIEW_W * (0.012 + 0.006 * hash01(i + 40));
    const wBot = wTop * 2.6;
    const slant = VIEW_W * 0.09;
    const topY = HUD_H;
    const botY = VIEW_H * 0.96;
    const grad = ctx.createLinearGradient(0, topY, 0, botY);
    grad.addColorStop(0, `rgba(140, 214, 255, ${(0.11 * f * breath).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(140, 214, 255, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(baseX - wTop, topY);
    ctx.lineTo(baseX + wTop, topY);
    ctx.lineTo(baseX + slant + wBot, botY);
    ctx.lineTo(baseX + slant - wBot, botY);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Cinematic vignette — always on for depth-of-frame, deepening as the water
 * rises, with the red danger pulse folded in once the survivor is struggling.
 */
function drawCinematicVignette(now: number): void {
  const h = waterHeightTiles(now);
  const base = 0.2 + 0.32 * Math.pow(Math.min(1, h / WATER_HEAD), 1.2);
  const cy = BOARD_Y + BOARD_H / 2;
  const vg = ctx.createRadialGradient(VIEW_W / 2, cy, VIEW_W * 0.42, VIEW_W / 2, cy, VIEW_W * 0.85);
  vg.addColorStop(0, 'rgba(1, 8, 16, 0)');
  vg.addColorStop(1, `rgba(1, 8, 16, ${base.toFixed(3)})`);
  ctx.fillStyle = vg;
  ctx.fillRect(0, HUD_H, VIEW_W, VIEW_H - HUD_H);

  if (state.phase === 'playing' && h >= WATER_CHEST) {
    const pulse = 0.08 + 0.08 * Math.abs(Math.sin(now / 220));
    const g = ctx.createLinearGradient(0, HUD_H, 0, VIEW_H);
    g.addColorStop(0, `rgba(255, 97, 97, ${pulse.toFixed(3)})`);
    g.addColorStop(0.3, 'rgba(255, 97, 97, 0)');
    g.addColorStop(0.7, 'rgba(255, 97, 97, 0)');
    g.addColorStop(1, `rgba(255, 97, 97, ${pulse.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, HUD_H, VIEW_W, VIEW_H - HUD_H);
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

  // Flood ticker + water gauge, centered.
  if (state.phase === 'playing') {
    ctx.textAlign = 'center';
    const h = waterHeightTiles(now);
    const tLeft = secondsUntilDrown(now);
    const struggling = h >= WATER_CHEST;
    const urgent = struggling && Math.floor(now / 220) % 2 === 0;
    ctx.fillStyle = urgent ? COLORS.danger : COLORS.breachFoam;
    ctx.font = `700 ${Math.floor(HUD_H * 0.19)}px sans-serif`;
    ctx.fillText(
      struggling ? `🌊 DROWNING in ${tLeft.toFixed(1)}s` : `🌊 overhead in ${Math.ceil(tLeft)}s`,
      VIEW_W / 2,
      HUD_H * 0.36
    );

    // Water gauge: a slim graded bar filling toward the drown mark, with a
    // notch at chest depth (where the struggling starts).
    const gw = VIEW_W * 0.26;
    const gh = Math.max(4, HUD_H * 0.09);
    const gx = VIEW_W / 2 - gw / 2;
    const gy = HUD_H * 0.6;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    roundRect(gx, gy, gw, gh, gh / 2);
    ctx.fill();
    const frac = Math.min(1, h / WATER_HEAD);
    if (frac > 0.03) {
      const fg = ctx.createLinearGradient(gx, 0, gx + gw, 0);
      fg.addColorStop(0, '#67c7ef');
      fg.addColorStop(0.6, '#2f8fc4');
      fg.addColorStop(1, '#ff6161');
      ctx.fillStyle = fg;
      roundRect(gx, gy, Math.max(gh, gw * frac), gh, gh / 2);
      ctx.fill();
    }
    // Chest-depth notch.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(gx + gw * (WATER_CHEST / WATER_HEAD) - 1, gy - 1.5, 2, gh + 3);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    roundRect(gx, gy, gw, gh, gh / 2);
    ctx.stroke();
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
