# Raahi NOW — deployable app

Real, expiring travel recommendations from verified locals: **Drops** (recommendations that expire and cap out), **Ask Raahi** (state your situation, locals answer with one recommendation each), and **Book the Person** (book the local behind the Drop).

This is the real, runnable source-code version of Raahi NOW, built to live at **now.raahi.io**. The Muse prototype was a preview only — this folder is the codebase you deploy.

**All payments are DEMO.** Payment methods are selected and recorded, and demo credits move in a demo wallet, but no real money moves and no payment provider is called.

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
├── api/              # Vercel serverless functions (one file per endpoint)
│   ├── drops.js      GET  /api/drops?market=nyc|boston|ellsworth|kyoto|sigiriya|all
│   ├── markets.js    GET  /api/markets
│   ├── unlock.js     POST /api/unlock    { dropId, method }
│   ├── asks.js       GET/POST /api/asks
│   ├── answer.js     POST /api/answer    { askId, localId, text }
│   ├── bookings.js   GET/POST /api/bookings
│   ├── wallet.js     GET  /api/wallet
│   └── topup.js      POST /api/topup     { amount, method }
├── lib/
│   ├── api.js        # All API handlers — shared by server.js and /api functions
│   └── store.js      # Data layer: in-memory store seeded from data/seed.json
├── data/
│   └── seed.json     # Markets, locals, Drops, payment methods, pricing config
├── vercel.json       # Vercel config (serverless function settings)
└── package.json
```

**Expansion by design:** markets are data, not pages. The hierarchy is country → city/region → local → Drop, all defined in `data/seed.json`. Adding a new country or city = adding rows there (with its currency, language, timezone, and phase), not writing new code.

**Data layer:** `lib/store.js` keeps state in memory (per server instance on Vercel, per process locally) and is the only file that touches raw state. To go production, replace its internals with a real database — the API handlers and frontend do not change.

**Privacy rule built in:** a locked Drop's API response returns `exactPlace: null` and `meetDetail: null`. The exact location only exists in a response after that user unlocks the Drop.

## Seed data

6 illustrative Drops across all 5 launch markets (NYC, Boston, Ellsworth/Acadia, Kyoto, Sigiriya), each with a named local, an expiry window, a daily unlock cap, and a fuzzy location. Named locals include real Raahi experts (Steph, Suzy, Seth, Dula) alongside illustrative ones, and every seeded Drop carries an "Illustrative example" badge in the UI.

**Photos:** Drop images are external Unsplash URLs used as placeholders. They must be replaced by each local's own real photos before any public launch — Raahi NOW's rule is one real photo taken by the local, no stock.

## Payments (demo, open by design)

Payment method selection is currency-agnostic and defined in `seed.json`:

- **Ninjji** — native and preferred, listed first, lowest fees in the real model
- **Raahi Credits** — 1 credit = $1 display value
- **Other crypto** — BTC, ETH, USDC
- **Card**
- **Fiat** — USD, JPY, LKR (per market; each market config carries its currency)

No currency is exclusive. Locals choose their own payout currency (each local record carries `payoutCurrency`). Pricing config lives in one place in `seed.json`: Ask = 5 credits, unlocks = 1–3 credits per Drop, locals keep 80% / Raahi 20%.

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
3. Framework preset: **Other**. Build command: leave empty. Output directory: leave default (project root). No environment variables are needed (see below).
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

**None required for the demo.** The app runs with zero configuration.

Optional:

| Variable | Used for |
|---|---|
| `PORT` | Local server port (default 3000). Ignored on Vercel. |

Future production variables (not yet used by this code): a database URL, an auth provider's keys, and payment provider keys for Ninjji / card / crypto processors.

---

## What is NOT production yet — honestly

- **Real payments:** all payments are demo records. No Ninjji, card, or crypto processor is integrated, and no keys are read. Real checkout is a separate build once the open-payments model is wired to providers.
- **Real auth:** there is one implicit "demo traveller" and one demo wallet. No sign-up, login, or per-user accounts yet — so unlocks and wallet state are shared per server instance in this demo.
- **Persistent database:** state is in memory. On Vercel it resets when an instance cold-starts and is not shared across instances. Replace `lib/store.js` with a real database (Postgres/Supabase) before public launch.
- **Country gates:** Japan (Kyoto) and Sri Lanka (Sigiriya) are in the data model marked `phase: "expansion"`. Their paid launch still needs each country's laws, payment, and partner pass (Raahi's standing US-first discipline). Do not take real paid unlocks there until that pass is done.
- **Photos:** starter images are Unsplash placeholders (see Seed data above), not locals' real photos.
- **Production testing:** the app was tested locally (homepage + every API flow via curl). The Vercel deployment itself, the custom domain, and real-device browsing are untested until the deploy steps above are run with the user.
