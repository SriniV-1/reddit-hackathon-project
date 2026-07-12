# 🌊 Last Voyage

A daily, procedurally-generated **"escape the sinking ship"** game built on Reddit's
**[Devvit Web](https://developers.reddit.com/)** platform. The ship is going down —
grab the pearls, dodge the sharks, and reach the lifeboat before the sea takes the deck.

Everything you see is drawn at runtime with the **native HTML5 Canvas API**. There are
**zero image assets** — the ship, water, pearls, sharks, whirlpools, lifeboat, and
player are all `fillRect` / `arc` / polygon primitives.

---

## 🎮 How to play

- You start bow-side at **[0,0]** with **3 HP** and **10 moves**.
- Tap/click an **orthogonally-adjacent** tile to glide there (smooth 150ms lerp — the
  player never teleports).
- **Pearls** `+10` · **Supply crates** `+50` · **Sharks / hull breaches** `−1 HP`.
- Reach the **lifeboat at [7,7]** for a `+100` bonus (plus 5 per unused move).
- The board is the **same for everyone each day** — it's seeded from the UTC date, so
  the leaderboard is a fair daily race.

### Relics (pick one at the start)

| Relic | Effect |
| --- | --- |
| 🥾 **Sea Legs** | +3 extra moves |
| 🧭 **Navigator's Compass** | Pearls worth ×2 |
| 🔱 **Harpoon** | Sharks give points and deal no damage |

---

## 🗂 Project structure

```
sinking-ship/
├── devvit.json              # Devvit Web app config (post + server + permissions)
├── package.json
├── tsconfig.json
├── vite.client.config.ts    # builds the canvas client -> dist/client
├── vite.server.config.ts    # builds the server bundle -> dist/server
└── src/
    ├── server/
    │   └── index.ts         # seeded daily board + Redis dedupe + faction scores
    └── client/
        ├── index.html       # full-screen <canvas> shell
        └── app.ts           # game loop, lerp animation, all canvas rendering
```

## 🔌 Server endpoints

| Method | Route | Purpose |
| --- | --- | --- |
| `GET`  | `/api/getDailyBoard` | Deterministic 8×8 board for today (10 pearls, 2 crates, 5 sharks, 3 breaches, lifeboat at [7,7]). Pure function of the date. |
| `POST` | `/api/submitRun` | Records a run **once per user per day** (Redis flag) and adds the score to the subreddit's "faction" total (Redis sorted set). |
| `POST` | `/internal/menu/create-post` | Moderator menu action that spawns a fresh game post. |

The daily board is generated with a **mulberry32** PRNG seeded from the `YYYY-MM-DD`
date string, so every player on a given day gets an identical layout.

---

## 🚀 Running it

> Requires the [Devvit CLI](https://developers.reddit.com/docs/) and a test subreddit
> you moderate.

```bash
npm install
npm install -g devvit        # if you don't have it
devvit login

# Point the app at your test subreddit:
#   devvit.json -> "dev": { "subreddit": "YOUR_TEST_SUB" }

npm run dev                  # devvit playtest — live-reloads on your subreddit
```

To ship it:

```bash
npm run deploy               # build + devvit upload (private)
npm run launch               # build + devvit publish (review for public listing)
```

---

## ⚠️ A note on Devvit versions

Devvit Web is young and its config/API surface still shifts between CLI releases. If the
CLI complains, these are the likely spots to adjust:

- **`devvit.json`** — the exact `post` / `server` / `permissions` schema. Validate
  against the `$schema` URL your installed CLI ships.
- **Server imports** — this project imports from `@devvit/web/server`. Some versions
  split these into `@devvit/server`, `@devvit/redis`, `@devvit/reddit`.
- **`reddit.submitCustomPost(...)`** in the create-post endpoint — the "create an app
  post" call has changed names across versions (`submitCustomPost` / `submitPost`).

The game logic, board generation, Redis usage, and the entire canvas client are
version-independent.
