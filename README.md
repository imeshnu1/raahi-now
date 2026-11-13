# Raahi NOW — deployable app

Real, expiring travel recommendations from verified locals: **Drops** (recommendations that expire and cap out), **Ask Raahi** (state your situation, locals answer with one recommendation each), and **Book the Person** (book the local behind the Drop).

This is the real, runnable source-code version of Raahi NOW, built to live at **now.raahi.io**. The Muse prototype was a preview only — this folder is the codebase you deploy.

**All payments are DEMO.** Payment methods are selected and recorded, and demo credits move in a demo wallet, but no real money moves and no payment provider is called.

---

## What's new in v2 — two-sided posting, events, Izzy slice 1

- **Offers** — any local (even a guest, no app needed) can post a hosted moment ("I have 2 hours and 2 spots in my car"). Guests get a one-time **claim code**: create a free Raahi Expert account later and link the post to get paid. `GET/POST /api/offers`
- **Buddy posts** — travelers post free "explore together" requests. Posting is open (name required for guests), but **only logged-in Raahi profiles can respond** — nobody travels with a total stranger. `GET/POST /api/buddies`, `POST /api/buddy-respond`
- **Events** — vendors post events (one seeded example: Tamara's Cheese Tasting, Ellsworth). `GET/POST /api/events`
- **Share kit + outbox** — every Drop/Offer/Event/Buddy card has per-platform copy (Instagram, TikTok/Shorts, Reddit, Facebook), Web Share, a downloadable PNG card, and "Queue for auto-posting" (`POST /api/share` → `outbox` table, drained later by Raahi's social engine). The UI honestly says "Queued", never "Posted".
- **Appreciation tips** — logged-in users can tip an Offer/Buddy/Event poster through the payments layer (`POST /api/tip`); you can't tip your own post.
- **Izzy matching, slice 1** — `lib/engine.js`, a pure rule-based matcher (same market, complementary post kinds). Lists carry a `matches` count; cards show an "Izzy match" chip. No AI claims.
- **Connection readiness** — NOW stays a separate product, with seams ready: `lib/config.js` (links to raahi.io / app.raahi.io, reserved `raahi-now://` scheme), `users.external_id` for a future Firebase identity map, booking `pickupLocation`, and **[INTEGRATION.md](INTEGRATION.md)** with the full connection plan.
- Tabs are now: Drops (Live Drops + Hosted by locals) · Ask Izzy · Buddies · Events · Wallet · Plan with Leo.
- Function budget: **11** serverless files in `api/` (Hobby limit 12) — auth, posts, and engagement endpoints are consolidated behind `vercel.json` rewrites.

---

## Run it locally

Requirements: Node.js 18 or newer. There are **no dependencies to install** (the app uses only the Node standard library), but `npm install` is harmless and generates the lockfile.

```bash
cd raahi-now-app
npm install   # optional — zero dependencies
npm start
```

Then open:

```
http://localhost:3000
```

That is the one command: `npm start` (same as `node server.js`). Pick a different port with `PORT=8080 npm start`.

What to try: filter Drops by market, unlock the Kyoto Drop with Ninjji, top up the wallet, post an Ask (5 demo credits), answer it as a local, and book Yuki S.

---

## Project structure

```
raahi-now-app/
├── index.html        # Single-page frontend (Drops / Ask / Wallet / Plan tabs)
├── public/styles.css # Palette only: #1A1A1A, #FFFFFF, #E8926A, #F4EFEA, #6B6B6B
├── public/main.js    # Frontend logic — talks only to /api/* (in public/, the static output dir)
├── server.js         # Local dev server (serves the frontend + /api locally)
├── api/              # Vercel serverless functions (11 files; Hobby limit is 12)
│   ├── drops.js      GET  /api/drops?market=nyc|boston|ellsworth|kyoto|sigiriya|all
│   ├── markets.js    GET  /api/markets
│   ├── unlock.js     POST /api/unlock    { dropId, method }
│   ├── asks.js       GET/POST /api/asks
│   ├── answer.js     POST /api/answer    { askId, localId, text }
│   ├── bookings.js   GET/POST /api/bookings     (login required)
│   ├── wallet.js     GET  /api/wallet  + /api/wallet-address (rewrite)
│   ├── topup.js      POST /api/topup     { amount, method }  (login required)
│   ├── auth.js       /api/signup /api/login /api/logout /api/me (rewrites)
│   ├── posts.js      /api/offers /api/buddies /api/events   (rewrites, v2)
│   └── engage.js     /api/share /api/tip /api/buddy-respond /api/outbox /api/outbox-update /api/social-accounts (rewrites, v2)
├── lib/
│   ├── api.js        # All API handlers — shared by server.js and /api functions
│   ├── store.js      # Data layer: Neon Postgres, or local JSON file fallback
│   ├── auth.js       # Accounts: scrypt password hashing + cookie sessions
│   ├── payments.js   # Payment provider abstraction (demo provider built in)
│   ├── social.js     # Social account registry + per-platform post text for the engine — v2
│   ├── engine.js     # Izzy matching, slice 1 (pure, rule-based) — v2
│   └── config.js     # Links to Raahi's other apps + connection config — v2
├── INTEGRATION.md    # How NOW connects to the main Raahi apps later
├── tests/run.cjs     # Full local test suite (fallback store): npm test
├── data/
│   ├── seed.json     # Markets, locals, Drops, payment methods, pricing config
│   └── dev-db.json   # Local dev fallback store (created at runtime, gitignored)
├── vercel.json       # Vercel config (serverless function settings)
└── package.json
```

**Expansion by design:** markets are data, not pages. The hierarchy is country → city/region → local → Drop, all defined in `data/seed.json`. Adding a new country or city = adding rows there (with its currency, language, timezone, and phase), not writing new code.

**Data layer:** `lib/store.js` is the only file that touches raw state, with two backends behind one async interface:

- **Neon Postgres (production):** when `DATABASE_URL` is set, the `@neondatabase/serverless` driver (HTTPS, built for Vercel serverless) is used. Tables are created on first use with idempotent DDL: `users` (incl. `wallet_address`), `sessions`, `wallets`, `unlocks`, `asks`, `answers`, `bookings`, `payments`, and `drop_counters` (unlock counts **and** each Drop's persisted `expires_at` window — seeded once, never reset on cold start; QA B3).
- **Local JSON fallback (development):** when `DATABASE_URL` is not set, state lives in `data/dev-db.json` (gitignored) with the same interface, so the app runs and tests fully locally with nothing provisioned.

Markets, locals, Drops content and payment methods stay as seed data in `data/seed.json` — content, not user state.

**Accounts & the login gate:** real accounts live in `lib/auth.js` — passwords hashed with `crypto.scrypt` + per-user salt (never stored or logged in plaintext), sessions are random tokens stored **hashed** in the `sessions` table and sent as an HttpOnly cookie (`rn_session`, 30 days). Browsing Drops/Asks is public; **unlock, Ask posting/answering, bookings, wallet and top-up require login (401 otherwise)**. Wallets are per-user; a new account starts with 12 demo credits. A user's connected crypto wallet address is saved on their account (`users.wallet_address`, set via `POST /api/wallet-address`) from the Connect Wallet flow (injected EVM wallet such as MetaMask, or a pasted address — no wallet lock-in).

**Privacy rule built in:** a locked Drop's API response returns `exactPlace: null` and `meetDetail: null`. The exact location only exists in a response after that user unlocks the Drop.

## Seed data

6 illustrative Drops across all 5 launch markets (NYC, Boston, Ellsworth/Acadia, Kyoto, Sigiriya), each with a named local, an expiry window, a daily unlock cap, and a fuzzy location. Named locals include real Raahi experts (Steph, Suzy, Seth, Dula) alongside illustrative ones, and every seeded Drop carries an "Illustrative example" badge in the UI.

**Photos:** Drop images are external Unsplash URLs used as placeholders. They must be replaced by each local's own real photos before any public launch — Raahi NOW's rule is one real photo taken by the local, no stock.

## Payments (demo, open by design)

Payment methods are defined in `seed.json`, in this order (US dollars first — amounts everywhere are shown in US dollars for now):

- **US dollars**
- **Raahi Credits** — 1 credit = $1 display value
- **Ninjji** — native and preferred, lowest fees in the real model
- **JellyJelly**, **Wobbles**, **SOL**, **USDC**

The crypto set is deliberately small to start. Locals choose their own payout currency (each local record carries `payoutCurrency`). Pricing config lives in one place in `seed.json`: Ask = 5 credits, unlocks = 1–3 credits per Drop, locals keep 80% / Raahi 20%.

**Provider abstraction:** every charge goes through `lib/payments.js` — handlers call `getProvider().createCharge(...)`, never a processor directly. The built-in provider is the **demo** provider (records marked demo, no real money). To connect a real crypto processor later: write one provider file implementing `createCharge` / `getStatus`, register it in `lib/payments.js`, and set env `PAYMENTS_PROVIDER` plus that processor's keys (e.g. `NINJJI_API_KEY`, `COINBASE_COMMERCE_API_KEY`) — configuration + one file, not a rewrite. Paying with a crypto method while a wallet is connected records the wallet address on the payment record.

**Social engine:** "Queue for auto-posting" writes to the `outbox` table. The Mac-mini social-pilot drains it through `GET /api/outbox` and reports back via `POST /api/outbox-update`, both gated by the `x-social-token` header (`SOCIAL_ENGINE_TOKEN` env var); `GET /api/social-accounts` publicly lists the account registry in `lib/social.js` (handles are null until Imesh provides the accounts). Full connection steps: **INTEGRATION.md → "Social engine connection"**.

---

## Deploy to Vercel

Do this together with the user — this codebase was delivered tested locally, not deployed.

### Option A — GitHub import (recommended, matches the Raahi pipeline: VM builds → GitHub → deploy)

1. Create a new GitHub repo (for example `raahi-now`) and push this folder to it:

```bash
cd raahi-now-app
git init
git add .
git commit -m "Raahi NOW deployable v1"
git branch -M main
git remote add origin https://github.com/<your-account>/raahi-now.git
git push -u origin main
```

2. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import the `raahi-now` repo.
3. Framework preset: **Other**. Build command: leave empty. Output directory: leave default (project root). Add the **Neon** integration (Storage tab) so `DATABASE_URL` is set — accounts need it (see Environment variables).
4. Click **Deploy**. Vercel serves the `public/` folder (`index.html` / `styles.css` / `main.js`) as static files and each file in `api/` as a serverless function.
5. Open the generated `*.vercel.app` URL and test: Drops load, unlock works, wallet top-up works.

### Option B — Vercel CLI

```bash
cd raahi-now-app
npx vercel        # first run links/creates the project, then deploys a preview
npx vercel --prod # production deploy
```

---

## Attach the custom domain: now.raahi.io

`raahi.io` is registered in **Amazon Route 53** (Raahi's account). `now.raahi.io` is a subdomain — no purchase needed.

1. In Vercel: open the `raahi-now` project → **Settings → Domains → Add** → enter `now.raahi.io`. Vercel will show the DNS record it needs (normally a CNAME to `cname.vercel-dns.com`).
2. In AWS Route 53: open the hosted zone for **raahi.io** → **Create record**:
   - Record name: `now`
   - Type: `CNAME`
   - Value: `cname.vercel-dns.com` (use the exact target Vercel shows if it differs)
   - TTL: 300
3. Wait for Vercel to verify the domain (usually minutes). Vercel issues the HTTPS certificate automatically.
4. Visit `https://now.raahi.io` and run the same test pass: Drops, unlock, Ask, booking, wallet.

Optionally later: add a page or redirect at `raahi.io/now` on the main site that sends people to `https://now.raahi.io`.

---

## Environment variables

| Variable | Used for |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string. On Vercel, adding the **Neon integration** to the project sets this automatically. When unset locally, the app uses the `data/dev-db.json` fallback store — fine for development, never for production. |
| `PAYMENTS_PROVIDER` | Payment provider name from `lib/payments.js`. Default `demo`. A real provider's keys (see Payments above) are read by its provider file when one is added. |
| `SOCIAL_ENGINE_TOKEN` | Shared secret for the social engine drain endpoints (`GET /api/outbox`, `POST /api/outbox-update`), sent as the `x-social-token` header. Set the same value in Vercel and on the Mac-mini social-pilot. When unset, both endpoints return 401 for everyone. See INTEGRATION.md → "Social engine connection". |
| `PORT` | Local server port (default 3000). Ignored on Vercel. |

Auth needs no keys: password hashing and sessions are implemented with Node's built-in crypto (`lib/auth.js`).

---

## What is NOT production yet — honestly

- **Real payments:** all payments are still demo records via the demo provider in `lib/payments.js`. No Ninjji, card, or crypto processor moves real money yet — the integration point (provider interface + `PAYMENTS_PROVIDER` + processor keys) is built and documented, and the Connect Wallet flow saves users' wallet addresses, but real on-chain/card settlement is the next step.
- **Database on Vercel:** accounts, sessions, wallets, unlocks, Asks, bookings, payments and Drop windows are persistent in Neon **once `DATABASE_URL` is set on the project** (via the Neon integration). Until then the live deployment would use the local-file fallback, which does not persist across serverless instances — connect Neon before relying on accounts in production. The Neon path is verified locally for module load/query behavior; the live end-to-end check happens right after the integration is connected on Vercel.
- **Country gates:** Japan (Kyoto) and Sri Lanka (Sigiriya) are in the data model marked `phase: "expansion"`. Their paid launch still needs each country's laws, payment, and partner pass (Raahi's standing US-first discipline). Do not take real paid unlocks there until that pass is done.
- **Photos:** starter images are Unsplash placeholders (see Seed data above), not locals' real photos.
- **Production testing:** the app was tested locally (homepage + every API flow via curl). The Vercel deployment itself, the custom domain, and real-device browsing are untested until the deploy steps above are run with the user.
