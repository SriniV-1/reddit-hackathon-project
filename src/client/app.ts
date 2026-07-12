/**
 * ============================================================================
 *  LAST VOYAGE — Devvit Web client (100% HTML5 Canvas, zero image assets)
 * ============================================================================
 *  The ship is going down. You start bow-side at [0,0] with 3 HP and 10 moves.
 *  Grab pearls, crack open supply crates, dodge sharks and hull breaches, and
 *  reach the lifeboat at [7,7] before the sea swallows the deck.
 *
 *  Rendering rules:
 *    • Every entity is drawn with fillRect / arc / polygons — no PNG/JPG.
 *    • The player LERPS between tiles over ~150ms (never teleports).
 *    • Collecting a pearl spawns an expanding-ring particle burst.
 *    • The waterline creeps up the deck as your moves run out — the ship sinks.
 *
 *  State machine:  loading → relic → playing → gameover
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Shared vocabulary — mirrors src/server/index.ts (kept in sync by hand).
// ---------------------------------------------------------------------------
type Tile = 'empty' | 'pearl' | 'crate' | 'shark' | 'breach' | 'lifeboat';

interface DailyBoard {
  date: string;
  size: number;
  grid: Tile[][]; // grid[row][col]
}

type Phase = 'loading' | 'relic' | 'playing' | 'gameover';
type Ending = 'escaped' | 'drowned' | 'stranded' | null;

type RelicId = 'seaLegs' | 'compass' | 'harpoon';
interface Relic {
  id: RelicId;
  name: string;
  blurb: string;
  emoji: string;
}

// ---------------------------------------------------------------------------
// Tunables.
// ---------------------------------------------------------------------------
const BOARD_SIZE = 8;
const BASE_MAX_STEPS = 10;
const START_HP = 3;
const MOVE_MS = 150; // lerp duration between tiles

const POINTS = {
  pearl: 10,
  crate: 50,
  harpoonKill: 25, // shark points when you carry the Harpoon
  lifeboat: 100, // bonus for escaping
  perLeftoverStep: 5, // bonus per unused move on escape
} as const;

const RELICS: Relic[] = [
  { id: 'seaLegs', name: 'Sea Legs', blurb: '+3 extra moves', emoji: '🥾' },
  { id: 'compass', name: "Navigator's Compass", blurb: 'Pearls worth ×2', emoji: '🧭' },
  { id: 'harpoon', name: 'Harpoon', blurb: 'Sharks give points, deal no damage', emoji: '🔱' },
];

// Palette — high-contrast, ocean-forward.
const COLORS = {
  deckLight: '#c9a26b',
  deckDark: '#b18b56',
  deckLine: '#5b4426',
  hullDark: '#3a2c17',
  pearl: '#eafcff',
  pearlCore: '#9fe8ff',
  crate: '#a9752f',
  crateBand: '#5e3d15',
  shark: '#6b7f8c',
  sharkBelly: '#c3d0d8',
  breach: '#0a2233',
  breachFoam: '#7fd4ff',
  lifeboat: '#ff6b3d',
  lifeboatTrim: '#ffe8d6',
  player: '#2fa8ff',
  playerVest: '#ff9d2e',
  water: '#0e5c86',
  waterTop: '#67c7ef',
  hud: '#e9f6ff',
  panel: 'rgba(3, 20, 33, 0.82)',
  gold: '#ffd23f',
} as const;

// ---------------------------------------------------------------------------
// Canvas + DPR setup. Logical layout is portrait: [ HUD | 8x8 board | footer ].
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let VIEW_W = 0; // logical (css) width
let VIEW_H = 0; // logical (css) height
let HUD_H = 0; // top HUD band height
let BOARD_PX = 0; // board is a square of side BOARD_PX
let TILE = 0; // one tile side
let BOARD_Y = 0; // y offset where the board starts

/** Recompute layout + backing-store size for the current window / DPR. */
function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  // Largest portrait footprint (aspect 1 : 1.25) that fits the window.
  const w = Math.min(window.innerWidth, window.innerHeight / 1.25);
  VIEW_W = Math.floor(w);
  HUD_H = Math.floor(VIEW_W * 0.16);
  BOARD_PX = VIEW_W;
  TILE = BOARD_PX / BOARD_SIZE;
  BOARD_Y = HUD_H;
  const footer = Math.floor(VIEW_W * 0.09);
  VIEW_H = HUD_H + BOARD_PX + footer;

  // CSS size (what the user sees) vs backing store (crisp on retina).
  canvas.style.width = `${VIEW_W}px`;
  canvas.style.height = `${VIEW_H}px`;
  canvas.width = Math.floor(VIEW_W * dpr);
  canvas.height = Math.floor(VIEW_H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in logical px from here on
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Game state.
// ---------------------------------------------------------------------------
interface Particle {
  x: number;
  y: number;
  born: number; // timestamp
  life: number; // ms
  hue: string;
}

interface MoveAnim {
  fromR: number;
  fromC: number;
  toR: number;
  toC: number;
  start: number; // timestamp
}

const state = {
  phase: 'loading' as Phase,
  error: '' as string,

  board: null as DailyBoard | null,

  // player position in *tile units* (integers when idle, fractional mid-lerp)
  playerR: 0,
  playerC: 0,
  move: null as MoveAnim | null,

  hp: START_HP,
  maxSteps: BASE_MAX_STEPS,
  stepsUsed: 0,
  score: 0,
  relic: null as RelicId | null,

  ending: null as Ending,
  particles: [] as Particle[],

  // submit lifecycle
  submitState: 'idle' as 'idle' | 'sending' | 'done' | 'error',
  submitMsg: '',

  // relic-card hit rectangles (filled during render, read during input)
  relicHitboxes: [] as Array<{ id: RelicId; x: number; y: number; w: number; h: number }>,

  // gentle idle bob clock
  t0: performance.now(),
};

// ---------------------------------------------------------------------------
// Boot: fetch today's board, then move to relic selection.
// ---------------------------------------------------------------------------
async function loadBoard(): Promise<void> {
  try {
    const res = await fetch('/api/getDailyBoard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const board: DailyBoard = await res.json();
    state.board = board;
    state.phase = 'relic';
  } catch (err) {
    state.error = `Couldn't load today's ship. ${String(err)}`;
    state.phase = 'relic'; // still show the menu; we surface the error there
  }
}
void loadBoard();

// ---------------------------------------------------------------------------
// Input. One handler for mouse + touch; we translate to logical canvas coords.
// ---------------------------------------------------------------------------
function toLogical(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (VIEW_W / rect.width),
    y: (clientY - rect.top) * (VIEW_H / rect.height),
  };
}

function handlePointer(clientX: number, clientY: number): void {
  const { x, y } = toLogical(clientX, clientY);

  if (state.phase === 'relic') {
    // Pick whichever relic card was tapped.
    for (const hb of state.relicHitboxes) {
      if (x >= hb.x && x <= hb.x + hb.w && y >= hb.y && y <= hb.y + hb.h) {
        chooseRelic(hb.id);
        return;
      }
    }
    return;
  }

  if (state.phase === 'playing') {
    if (state.move) return; // ignore taps mid-glide

    // Map the tap to a board cell.
    if (y < BOARD_Y || y > BOARD_Y + BOARD_PX) return;
    const c = Math.floor(x / TILE);
    const r = Math.floor((y - BOARD_Y) / TILE);
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return;

    // Only orthogonally-adjacent tiles are legal.
    const dr = Math.abs(r - state.playerR);
    const dc = Math.abs(c - state.playerC);
    if (dr + dc === 1) startMove(r, c);
    return;
  }
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

// ---------------------------------------------------------------------------
// Gameplay transitions.
// ---------------------------------------------------------------------------
function chooseRelic(id: RelicId): void {
  if (!state.board) return; // don't start if the board failed to load
  state.relic = id;
  state.maxSteps = BASE_MAX_STEPS + (id === 'seaLegs' ? 3 : 0);
  state.phase = 'playing';
}

function startMove(toR: number, toC: number): void {
  state.move = {
    fromR: state.playerR,
    fromC: state.playerC,
    toR,
    toC,
    start: performance.now(),
  };
}

/** Called the instant a lerp completes — snap position + resolve the tile. */
function finishMove(): void {
  const mv = state.move!;
  state.move = null;
  state.playerR = mv.toR;
  state.playerC = mv.toC;
  state.stepsUsed += 1;

  resolveTile(mv.toR, mv.toC);

  // End conditions, checked in priority order.
  if (state.hp <= 0) return endRun('drowned');
  if (state.board!.grid[mv.toR][mv.toC] === 'lifeboat') return endRun('escaped');
  if (state.stepsUsed >= state.maxSteps) return endRun('stranded');
}

/** Apply the consequences of stepping onto a tile, then clear it. */
function resolveTile(r: number, c: number): void {
  const grid = state.board!.grid;
  const tile = grid[r][c];
  const cx = c * TILE + TILE / 2;
  const cy = BOARD_Y + r * TILE + TILE / 2;

  switch (tile) {
    case 'pearl': {
      const value = POINTS.pearl * (state.relic === 'compass' ? 2 : 1);
      state.score += value;
      burst(cx, cy, COLORS.pearlCore);
      grid[r][c] = 'empty';
      break;
    }
    case 'crate': {
      state.score += POINTS.crate;
      burst(cx, cy, COLORS.gold);
      grid[r][c] = 'empty';
      break;
    }
    case 'shark': {
      if (state.relic === 'harpoon') {
        state.score += POINTS.harpoonKill; // you win the fight
        burst(cx, cy, COLORS.gold);
      } else {
        state.hp -= 1;
        burst(cx, cy, '#ff4d4d');
      }
      grid[r][c] = 'empty';
      break;
    }
    case 'breach': {
      state.hp -= 1;
      burst(cx, cy, COLORS.breachFoam);
      grid[r][c] = 'empty';
      break;
    }
    case 'lifeboat': {
      const leftover = state.maxSteps - state.stepsUsed;
      state.score += POINTS.lifeboat + Math.max(0, leftover) * POINTS.perLeftoverStep;
      burst(cx, cy, COLORS.lifeboat);
      break;
    }
    case 'empty':
    default:
      break;
  }
}

function endRun(ending: Ending): void {
  state.ending = ending;
  state.phase = 'gameover';
  void submitRun();
}

/** Spawn a few expanding rings for a collect/hit effect. */
function burst(x: number, y: number, hue: string): void {
  const now = performance.now();
  for (let i = 0; i < 3; i++) {
    state.particles.push({ x, y, born: now + i * 60, life: 520, hue });
  }
}

// ---------------------------------------------------------------------------
// Submit the finished run once. Server enforces one-per-day; we surface its
// verdict on the game-over screen.
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
    const data = await res.json();
    if (res.ok && data.ok) {
      state.submitState = 'done';
      state.submitMsg = `Logged! ${state.board?.date ?? ''}  •  Best: ${data.personalBest}  •  r/${data.faction}: ${data.factionTotal}`;
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

// ===========================================================================
//  RENDER LOOP
// ===========================================================================
function frame(now: number): void {
  // Clear (the HTML background shows through any letterboxing).
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);

  switch (state.phase) {
    case 'loading':
      drawLoading(now);
      break;
    case 'relic':
      drawRelicSelect(now);
      break;
    case 'playing':
      updateMove(now);
      drawGame(now);
      break;
    case 'gameover':
      drawGame(now); // freeze the board behind the panel
      drawGameOver(now);
      break;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** Advance the active lerp; hand off to finishMove() when it completes. */
function updateMove(now: number): void {
  if (!state.move) return;
  const mv = state.move;
  const t = Math.min(1, (now - mv.start) / MOVE_MS);
  // Smoothstep easing on top of the linear interpolation for a nicer glide.
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
// Screen: relic selection
// ---------------------------------------------------------------------------
function drawRelicSelect(now: number): void {
  paintSeaBackdrop(now);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Title.
  ctx.fillStyle = COLORS.gold;
  ctx.font = `800 ${Math.floor(VIEW_W * 0.11)}px sans-serif`;
  ctx.fillText('LAST VOYAGE', VIEW_W / 2, VIEW_H * 0.13);

  ctx.fillStyle = COLORS.hud;
  ctx.font = `500 ${Math.floor(VIEW_W * 0.038)}px sans-serif`;
  ctx.fillText('Grab the pearls. Reach the lifeboat.', VIEW_W / 2, VIEW_H * 0.2);

  if (state.error) {
    ctx.fillStyle = '#ff8a8a';
    ctx.font = `500 ${Math.floor(VIEW_W * 0.03)}px sans-serif`;
    ctx.fillText(state.error, VIEW_W / 2, VIEW_H * 0.25);
  }

  ctx.fillStyle = COLORS.hud;
  ctx.font = `700 ${Math.floor(VIEW_W * 0.045)}px sans-serif`;
  ctx.fillText('Choose your relic', VIEW_W / 2, VIEW_H * 0.3);

  // Three stacked relic cards.
  state.relicHitboxes = [];
  const cardW = VIEW_W * 0.8;
  const cardH = VIEW_H * 0.12;
  const cardX = (VIEW_W - cardW) / 2;
  const gap = VIEW_H * 0.03;
  let cardY = VIEW_H * 0.35;

  for (const relic of RELICS) {
    // Card background with a soft hover-ish glow (pulses gently).
    const pulse = 0.5 + 0.5 * Math.sin(now / 500 + cardY);
    ctx.fillStyle = COLORS.panel;
    roundRect(cardX, cardY, cardW, cardH, 14);
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 210, 63, ${0.35 + pulse * 0.4})`;
    ctx.lineWidth = 2;
    roundRect(cardX, cardY, cardW, cardH, 14);
    ctx.stroke();

    // Emoji badge.
    ctx.textAlign = 'left';
    ctx.font = `${Math.floor(cardH * 0.5)}px sans-serif`;
    ctx.fillText(relic.emoji, cardX + cardW * 0.06, cardY + cardH * 0.5);

    // Name + blurb.
    ctx.fillStyle = COLORS.gold;
    ctx.font = `700 ${Math.floor(cardH * 0.3)}px sans-serif`;
    ctx.fillText(relic.name, cardX + cardW * 0.22, cardY + cardH * 0.38);
    ctx.fillStyle = COLORS.hud;
    ctx.font = `500 ${Math.floor(cardH * 0.24)}px sans-serif`;
    ctx.fillText(relic.blurb, cardX + cardW * 0.22, cardY + cardH * 0.68);
    ctx.textAlign = 'center';

    state.relicHitboxes.push({ id: relic.id, x: cardX, y: cardY, w: cardW, h: cardH });
    cardY += cardH + gap;
  }
}

// ---------------------------------------------------------------------------
// Screen: the game (HUD + deck + entities + player + water + particles)
// ---------------------------------------------------------------------------
function drawGame(now: number): void {
  paintSeaBackdrop(now);
  drawHud();
  drawDeck();
  drawEntities(now);
  drawPlayer(now);
  drawRisingWater(now);
  drawParticles(now);
}

function drawHud(): void {
  // HUD band.
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(0, 0, VIEW_W, HUD_H);

  const pad = VIEW_W * 0.04;
  ctx.textBaseline = 'middle';

  // Hearts (HP).
  ctx.textAlign = 'left';
  ctx.font = `${Math.floor(HUD_H * 0.34)}px sans-serif`;
  let hearts = '';
  for (let i = 0; i < START_HP; i++) hearts += i < state.hp ? '❤️' : '🖤';
  ctx.fillText(hearts, pad, HUD_H * 0.34);

  // Relic label.
  const relic = RELICS.find((r) => r.id === state.relic);
  if (relic) {
    ctx.fillStyle = COLORS.hud;
    ctx.font = `500 ${Math.floor(HUD_H * 0.2)}px sans-serif`;
    ctx.fillText(`${relic.emoji} ${relic.name}`, pad, HUD_H * 0.72);
  }

  // Score.
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.gold;
  ctx.font = `800 ${Math.floor(HUD_H * 0.34)}px sans-serif`;
  ctx.fillText(`${state.score}`, VIEW_W - pad, HUD_H * 0.34);

  // Moves left.
  const left = Math.max(0, state.maxSteps - state.stepsUsed);
  ctx.fillStyle = left <= 3 ? '#ff8a8a' : COLORS.hud;
  ctx.font = `600 ${Math.floor(HUD_H * 0.2)}px sans-serif`;
  ctx.fillText(`${left} moves left`, VIEW_W - pad, HUD_H * 0.72);
}

/** The wooden deck grid. */
function drawDeck(): void {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const x = c * TILE;
      const y = BOARD_Y + r * TILE;
      // Checkerboard plank shading.
      ctx.fillStyle = (r + c) % 2 === 0 ? COLORS.deckLight : COLORS.deckDark;
      ctx.fillRect(x, y, TILE, TILE);
      // Plank seams.
      ctx.strokeStyle = COLORS.deckLine;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
    }
  }

  // Highlight legal (adjacent) moves so the player knows where they can go.
  if (state.phase === 'playing' && !state.move) {
    const pr = Math.round(state.playerR);
    const pc = Math.round(state.playerC);
    const nbrs: Array<[number, number]> = [
      [pr - 1, pc],
      [pr + 1, pc],
      [pr, pc - 1],
      [pr, pc + 1],
    ];
    ctx.fillStyle = 'rgba(103, 199, 239, 0.28)';
    for (const [r, c] of nbrs) {
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue;
      ctx.fillRect(c * TILE, BOARD_Y + r * TILE, TILE, TILE);
    }
  }
}

/** Draw every entity on the board. */
function drawEntities(now: number): void {
  const grid = state.board!.grid;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cx = c * TILE + TILE / 2;
      const cy = BOARD_Y + r * TILE + TILE / 2;
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
  }
}

// --- Entity primitives -----------------------------------------------------

function drawPearl(cx: number, cy: number, now: number): void {
  const bob = Math.sin(now / 400 + cx) * TILE * 0.04;
  const rad = TILE * 0.24;
  // Iridescent radial fill.
  const g = ctx.createRadialGradient(cx - rad * 0.3, cy - rad * 0.3 + bob, rad * 0.2, cx, cy + bob, rad);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.5, COLORS.pearl);
  g.addColorStop(1, COLORS.pearlCore);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy + bob, rad, 0, Math.PI * 2);
  ctx.fill();
  // Specular highlight.
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(cx - rad * 0.35, cy - rad * 0.35 + bob, rad * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

function drawCrate(cx: number, cy: number): void {
  const s = TILE * 0.56;
  const x = cx - s / 2;
  const y = cy - s / 2;
  ctx.fillStyle = COLORS.crate;
  ctx.fillRect(x, y, s, s);
  ctx.strokeStyle = COLORS.crateBand;
  ctx.lineWidth = Math.max(2, TILE * 0.04);
  ctx.strokeRect(x, y, s, s);
  // Diagonal cross-planks.
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + s, y + s);
  ctx.moveTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.stroke();
}

function drawShark(cx: number, cy: number, now: number): void {
  const sway = Math.sin(now / 300 + cy) * TILE * 0.05;
  const bodyR = TILE * 0.3;
  ctx.save();
  ctx.translate(cx + sway, cy);

  // Body (rounded).
  ctx.fillStyle = COLORS.shark;
  ctx.beginPath();
  ctx.ellipse(0, 0, bodyR * 1.15, bodyR * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  // Belly.
  ctx.fillStyle = COLORS.sharkBelly;
  ctx.beginPath();
  ctx.ellipse(0, bodyR * 0.28, bodyR * 0.9, bodyR * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  // Dorsal fin.
  ctx.fillStyle = COLORS.shark;
  ctx.beginPath();
  ctx.moveTo(-bodyR * 0.1, -bodyR * 0.7);
  ctx.lineTo(bodyR * 0.25, -bodyR * 1.35);
  ctx.lineTo(bodyR * 0.5, -bodyR * 0.6);
  ctx.closePath();
  ctx.fill();
  // Tail.
  ctx.beginPath();
  ctx.moveTo(bodyR * 1.05, 0);
  ctx.lineTo(bodyR * 1.6, -bodyR * 0.5);
  ctx.lineTo(bodyR * 1.6, bodyR * 0.5);
  ctx.closePath();
  ctx.fill();
  // Eye (angry).
  ctx.fillStyle = '#0b0b0b';
  ctx.beginPath();
  ctx.arc(-bodyR * 0.5, -bodyR * 0.1, bodyR * 0.12, 0, Math.PI * 2);
  ctx.fill();
  // Toothy grin.
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.5, TILE * 0.03);
  ctx.beginPath();
  ctx.moveTo(-bodyR * 0.9, bodyR * 0.15);
  ctx.lineTo(-bodyR * 0.2, bodyR * 0.15);
  ctx.stroke();

  ctx.restore();
}

/** Hull breach / whirlpool — a spiky polygon vortex, per spec. */
function drawBreach(cx: number, cy: number, now: number): void {
  const spin = now / 600;
  const spikes = 9;
  const outer = TILE * 0.32;
  const inner = TILE * 0.16;
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
  // Swirling foam core.
  ctx.rotate(-spin * 2);
  ctx.beginPath();
  ctx.arc(0, 0, inner * 0.6, 0, Math.PI * 1.5);
  ctx.stroke();
  ctx.restore();
}

function drawLifeboat(cx: number, cy: number, now: number): void {
  const bob = Math.sin(now / 350) * TILE * 0.03;
  const w = TILE * 0.66;
  const h = TILE * 0.34;
  ctx.save();
  ctx.translate(cx, cy + bob);

  // Hull (half-ellipse boat).
  ctx.fillStyle = COLORS.lifeboat;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h * 0.2);
  ctx.quadraticCurveTo(0, h, w / 2, -h * 0.2);
  ctx.closePath();
  ctx.fill();
  // White trim line.
  ctx.strokeStyle = COLORS.lifeboatTrim;
  ctx.lineWidth = Math.max(2, TILE * 0.05);
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h * 0.2);
  ctx.lineTo(w / 2, -h * 0.2);
  ctx.stroke();
  // Little flag/mast so it reads as "goal".
  ctx.strokeStyle = COLORS.lifeboatTrim;
  ctx.lineWidth = Math.max(1.5, TILE * 0.03);
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.2);
  ctx.lineTo(0, -h * 0.9);
  ctx.stroke();
  ctx.fillStyle = COLORS.gold;
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.9);
  ctx.lineTo(w * 0.28, -h * 0.72);
  ctx.lineTo(0, -h * 0.55);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/** The player: a blue survivor ringed by an orange life-vest. */
function drawPlayer(now: number): void {
  const cx = state.playerC * TILE + TILE / 2;
  const cy = BOARD_Y + state.playerR * TILE + TILE / 2;
  const bob = state.move ? 0 : Math.sin(now / 350) * TILE * 0.03;
  const rad = TILE * 0.26;

  // Life-vest ring.
  ctx.fillStyle = COLORS.playerVest;
  ctx.beginPath();
  ctx.arc(cx, cy + bob, rad * 1.35, 0, Math.PI * 2);
  ctx.fill();
  // Body.
  ctx.fillStyle = COLORS.player;
  ctx.beginPath();
  ctx.arc(cx, cy + bob, rad, 0, Math.PI * 2);
  ctx.fill();
  // Sheen.
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.beginPath();
  ctx.arc(cx - rad * 0.35, cy - rad * 0.35 + bob, rad * 0.25, 0, Math.PI * 2);
  ctx.fill();
  // Vest strap cross.
  ctx.strokeStyle = COLORS.lifeboatTrim;
  ctx.lineWidth = Math.max(1.5, TILE * 0.03);
  ctx.beginPath();
  ctx.moveTo(cx - rad * 0.5, cy + bob);
  ctx.lineTo(cx + rad * 0.5, cy + bob);
  ctx.stroke();
}

/**
 * Rising water. As moves deplete, a translucent sea creeps up the deck from the
 * bottom with an animated wavy top edge — the ship is going under.
 */
function drawRisingWater(now: number): void {
  const progress = Math.min(1, state.stepsUsed / state.maxSteps);
  const waterHeight = BOARD_PX * progress;
  if (waterHeight <= 0) return;

  const top = BOARD_Y + BOARD_PX - waterHeight;
  const amp = TILE * 0.12;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, VIEW_H);
  ctx.lineTo(0, top);
  // Wavy surface.
  const segs = 24;
  for (let i = 0; i <= segs; i++) {
    const x = (i / segs) * VIEW_W;
    const y = top + Math.sin(now / 260 + i * 0.6) * amp;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(VIEW_W, VIEW_H);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, top, 0, VIEW_H);
  grad.addColorStop(0, 'rgba(103, 199, 239, 0.55)');
  grad.addColorStop(1, 'rgba(14, 92, 134, 0.78)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Foam highlight on the crest.
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= segs; i++) {
    const x = (i / segs) * VIEW_W;
    const y = top + Math.sin(now / 260 + i * 0.6) * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Expanding-ring particles (pearl pickups, hits). */
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

// ---------------------------------------------------------------------------
// Screen: game over
// ---------------------------------------------------------------------------
function drawGameOver(now: number): void {
  // Dim the frozen board.
  ctx.fillStyle = 'rgba(1, 18, 31, 0.72)';
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
  ctx.font = `800 ${Math.floor(VIEW_W * 0.09)}px sans-serif`;
  ctx.fillText(info.text, VIEW_W / 2, VIEW_H * 0.34);

  // Final score.
  ctx.fillStyle = COLORS.gold;
  ctx.font = `800 ${Math.floor(VIEW_W * 0.16)}px sans-serif`;
  ctx.fillText(`${state.score}`, VIEW_W / 2, VIEW_H * 0.48);
  ctx.fillStyle = COLORS.hud;
  ctx.font = `500 ${Math.floor(VIEW_W * 0.035)}px sans-serif`;
  ctx.fillText('pearls & plunder', VIEW_W / 2, VIEW_H * 0.55);

  // Submission status.
  let statusText = '';
  if (state.submitState === 'sending') statusText = `Logging your voyage${'.'.repeat(1 + (Math.floor(now / 400) % 3))}`;
  else statusText = state.submitMsg;

  ctx.fillStyle = state.submitState === 'error' ? '#ff8a8a' : COLORS.hud;
  ctx.font = `500 ${Math.floor(VIEW_W * 0.03)}px sans-serif`;
  wrapText(statusText, VIEW_W / 2, VIEW_H * 0.66, VIEW_W * 0.86, VIEW_W * 0.045);

  ctx.fillStyle = 'rgba(233, 246, 255, 0.6)';
  ctx.font = `500 ${Math.floor(VIEW_W * 0.028)}px sans-serif`;
  ctx.fillText('A new ship sails at midnight (UTC).', VIEW_W / 2, VIEW_H * 0.8);
}

// ---------------------------------------------------------------------------
// Shared backdrop + small canvas helpers.
// ---------------------------------------------------------------------------
function paintSeaBackdrop(now: number): void {
  // Deep-ocean vertical gradient.
  const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
  g.addColorStop(0, '#0b3a5b');
  g.addColorStop(1, '#01121f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // A few parallax swells for life.
  ctx.strokeStyle = 'rgba(103, 199, 239, 0.12)';
  ctx.lineWidth = 2;
  for (let row = 0; row < 5; row++) {
    const baseY = (VIEW_H / 5) * row + (now / 40) % (VIEW_H / 5);
    ctx.beginPath();
    for (let x = 0; x <= VIEW_W; x += 16) {
      const y = baseY + Math.sin(x / 40 + now / 500 + row) * 6;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/** Rounded-rect path helper (fill/stroke by the caller). */
function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Very small word-wrap for the game-over status line. */
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
