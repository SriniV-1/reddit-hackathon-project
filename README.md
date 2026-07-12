# 🌊 Last Voyage

**The ship sinks at midnight. Everyone sails the same wreck. One scored run a day.**

Last Voyage is a daily escape game for Reddit communities, built on
**[Reddit's Developer Platform (Devvit Web)](https://developers.reddit.com/)**. Every day
at midnight UTC a new ship goes down — the same procedurally-generated deck for every
player on Reddit. You get **one scored voyage per day**: pick a relic, dash across the
flooding deck, grab pearls, dodge sharks, and reach the lifeboat before your moves run
out and the sea takes the board.

Everything on screen — the moonlit title ship, waves, pearls, sharks, whirlpools, the
lifeboat, every particle — is drawn live with the **HTML5 Canvas API** in a 2.5D
"GBA-overworld" style (beveled tiles, drop shadows, painter's-order entities, a walking
chibi survivor), and every sound is **synthesized with WebAudio oscillators**. There are
*zero* image or audio assets in this app.

---

## 🎮 How to play

1. **Set sail** from the title screen (once per day — after that, practice runs are free
   and unlimited, but only the first voyage counts).
2. **Choose a relic:**
   | Relic | Effect |
   | --- | --- |
   | 🥾 **Sea Legs** | +4 extra moves |
   | 🧭 **Navigator's Compass** | Pearls are worth ×2 |
   | 🔱 **Harpoon** | Sharks give +25 points and deal no damage |
3. **Move** by tapping any adjacent tile (or arrow keys / WASD on desktop). You start at
   the stern `[0,0]` with **3 HP** and **18 moves**; the lifeboat waits at `[7,7]` —
   exactly 14 moves away if you sprint, so every detour for treasure is a gamble.
4. **The ship sinks in real time.** After a 20-second grace period the stern row goes
   under, and the flood claims another row every 8 seconds, chasing you toward the
   lifeboat. **Wading through flooded tiles costs 1 HP per step** — and if the water
   catches the row you're standing on, you take a hit. Think fast, move faster.
5. **Score:** 🦪 pearl **+10** · 📦 supply crate **+50** · 🚣 lifeboat **+100** (plus
   +5 per unused move) · 🦈 shark / 🌀 hull breach **−1 HP**.

Die or strand and you score what you carried. Reach the lifeboat and escape with a bonus.

## ⚓ The hook — why players come back

- **One shared daily ship.** The board is generated from the UTC date (mulberry32 PRNG),
  so the whole community races the *same* layout — perfect fuel for comment-section
  strategy talk: *"Did you find the double-crate line on today's ship?"*
- **One scored run per day** (enforced server-side in Redis) makes the attempt precious,
  Wordle-style. Practice runs let you rehearse for tomorrow.
- **🔥 Daily streaks** for consecutive-day voyages.
- **Today's Survivors leaderboard** — live top-10 for today's ship, right on the
  game-over screen, with your row highlighted.
- **Subreddit factions** — every score you log adds to *your subreddit's* all-time
  total, a cross-community tug-of-war stored in a Redis sorted set.
- **A live countdown to the next ship** on both the title and game-over screens, so the
  next session is always scheduled.

Every daily board is **guaranteed winnable**: the server BFS-checks that a hazard-free
route to the lifeboat exists within the move budget and deterministically re-rolls the
layout if not (still identical for all players). A regression test walks 3 years of
boards: `npm run test:boards`.

### Simulation-tuned difficulty

The move budget was chosen by simulating a year of daily boards with three bot
archetypes (safest-shortest-path *sprinter*, value-per-step *greedy collector*, and a
*random walker*):

| Budget | Optimal-greedy loot (of 12 treasures) | Feel |
| --- | --- | --- |
| 15–16 | 4.4–5.1 | one misjudged detour strands you — punishing |
| **18** | **5.7** | **grab 2-3 treasures with sharp routing, decline the rest** |
| 20+ | 6.2–7.3 | loot half the deck — no tension |

At 18, escape is always *possible* (100% for the sprinter bot), random play virtually
never escapes (<1%), and a state-space BFS confirmed that tanking hazards with HP never
shortcuts the route — HP purely forgives mistakes. The real-time flood then adds the
pressure that no static budget can: thinking time itself is a resource.

---

## 🗂 Project structure

```
├── devvit.json               # Devvit Web app config (post + server + permissions + menu)
├── package.json
├── tsconfig.json
├── vite.client.config.ts     # builds the canvas client  -> dist/client
├── vite.server.config.ts     # builds a self-contained server bundle -> dist/server
├── scripts/
│   └── local-playtest.mjs    # play locally without the Devvit runtime (mock API)
└── src/
    ├── server/
    │   └── index.ts          # seeded daily board · BFS winnability guard · Redis
    │                         #   streaks / dedupe / leaderboards / faction totals
    └── client/
        ├── index.html        # full-screen <canvas> shell
        └── app.ts            # game loop · 150ms lerp movement · particles ·
                              #   screen shake · WebAudio synth SFX · all rendering
```

## 🔌 Server endpoints

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/init` | One round trip that boots the client: today's board + username + streak + personal best + played-today flag + today's leaderboard. |
| `GET` | `/api/getDailyBoard` | Just the deterministic daily 8×8 board (10 pearls, 2 crates, 5 sharks, 3 breaches, lifeboat at [7,7]). |
| `POST` | `/api/submitRun` | Records a run **once per user per day** (Redis flag, 48h TTL), updates streak / personal best / daily leaderboard / subreddit faction total, and returns all of them. |
| `POST` | `/internal/menu/create-post` | Moderator menu action that creates a new game post. |

Scores are clamped server-side to the maximum a legitimate run can produce, so a
tampered client can't poison the leaderboard.

---

## 🚀 Running it

### On Reddit (the real thing)

Requires the [Devvit CLI](https://developers.reddit.com/docs/) and a test subreddit you
moderate:

```bash
npm install
npm install -g devvit
devvit login

npm run build
devvit playtest <your-test-subreddit>   # live-reloads on your subreddit
```

Then use the subreddit's mod menu → **"Launch a Last Voyage post"**.

To publish: `npm run deploy` (upload) or `npm run launch` (submit for review).

### Locally (no Devvit needed)

```bash
npm install
npm run playtest:local
# → http://localhost:7373
```

`scripts/local-playtest.mjs` serves the built client and mocks the API with the same
board-generation code and an in-memory Redis stand-in — handy for quick iteration and
for judging the game loop without an installed subreddit.

### Checks

```bash
npm run type-check    # strict TypeScript across client + server
npm run test:boards   # 3 years of daily boards must all be winnable
```
