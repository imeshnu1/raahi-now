# How Raahi NOW connects to the rest of Raahi — later

Raahi NOW is a **separate product surface**. It does not merge with the
main Raahi apps, and today it shares no login, no database, and no
booking flow with them:

| Surface | Where | What it is |
|---|---|---|
| Raahi web | https://raahi.io | Company / marketing home |
| Traveler web app | https://app.raahi.io | The main traveler product (Next.js, Firebase Auth, Raahi `/api/v1`) |
| Traveler app | Apple / Google stores | Native traveler app |
| Expert app | Apple / Google stores | Where locals/experts manage their storefront and get paid |
| **Raahi NOW** | now.raahi.io (this repo) | Drops, Ask Izzy, Offers, Buddies, Events — its own accounts + store |

Everything below is a **seam that already exists in this codebase**, so
connecting later is wiring, not surgery. Configuration lives in
`lib/config.js` (`LINKS`, `CONNECTION`).

## 1. Identity — one Raahi login, later

- NOW accounts are local today (`lib/auth.js`, scrypt + cookie
  sessions), provider name: `local` (`CONNECTION.identityProvider`).
- The intended future provider is Firebase — the same Firebase project
  the main app uses (`CONNECTION.futureIdentityProvider = 'firebase'`).
- The mapping column already exists: **`users.external_id`** (nullable
  text, migrated idempotently in `lib/store.js` for both backends,
  surfaced as `externalId` on `/api/me`, currently `null`).
- Connection day looks like: a user signs in with Firebase on
  `now.raahi.io` (the subdomain must be added as an authorized domain
  in that Firebase project), NOW looks up `users.external_id = <uid>`,
  and if there's no row yet, links or creates the local account and
  stamps the UID. Sessions, wallets, unlocks and posts don't move.
- Guest posts carry a **claim token** (`offers.claim_token`,
  `events.claim_token`): a guest who later creates a Raahi Expert
  account presents the code and the post (and its earnings) attach to
  that account. That flow's redemption endpoint is future work — the
  tokens are already issued and stored.

## 2. Bookings — payload mapping to Raahi `/api/v1`

NOW booking rows (`bookings` table; `detail` JSON holds the fields)
map onto the main app's booking shape like this:

| NOW field | Main Raahi booking field | Notes |
|---|---|---|
| `localId` | expert id | Only for seed locals today; becomes the expert's id once locals link to expert profiles |
| `localName` | expert display name | Used for Offer bookings, where the host is a regular person, not (yet) an expert profile |
| `offerId` / `dropId` | source listing id | Which NOW surface the booking came from |
| `when` (free text) | booking date/time | NOW is free-text today; the main app wants a real date + time — parse/confirm at handoff |
| `people` | guests | Already validated whole 1–12 (QA B5) |
| `pickupLocation` | pickup location | Optional, already collected in the book modal |
| `method` | payment method | Open set (Ninjji/crypto/card/fiat); the main app's checkout is real-currency — settlement mapping is a product decision, not a code problem |
| `status` | status | NOW starts at `waiting for confirmation`, same lifecycle idea |

Until the handoff exists, NOW bookings stay in NOW. Nothing is sent
to the main app's API yet — that stays true until Imesh decides
bookings should flow through (tracked as a product decision, not a
bug).

## 3. Social distribution — the outbox and the social engine

- Every Drop, Offer, Event, and Buddy post has a Share kit in the UI:
  per-platform copy (Instagram, TikTok / YouTube Shorts, Reddit,
  Facebook), Web Share, and a downloadable 1080×1080 PNG card.
- "Queue for auto-posting" writes to the **`outbox`** table via
  `POST /api/share`: `{ kind, refId, platform: 'all', payload, status:
  'queued', userId }`. The payload is the ready-to-post text built
  from the item's real fields.
- The auto-posting engine is Raahi's social-pilot (running on the Mac
  mini). Connection day: the engine polls/drains `outbox` rows with
  `status = 'queued'`, posts them, and marks them sent. NOW never
  claims something was posted — the UI says "Queued" until the engine
  confirms otherwise.

## 4. Izzy — the central travel engine

Izzy is Raahi's patent-pending intelligent travel engine. NOW feeds it
five kinds of live, human signals — **Asks, Drops, Offers, Buddy
posts, and Events** — all already structured with market, time, and
party/price fields.

Slice 1 lives in **`lib/engine.js`**: a pure function
`matchFor({ marketId, kind, offers, buddies, events })` that returns
same-market complementary posts (a buddy post ↔ offers + events; an
offer or event ↔ buddy posts). The API attaches a `matches` count to
each listed item; the UI shows an "Izzy match" chip. No AI claims —
it's rules, and it's labelled honestly.

Later slices plug into the same module: time windows, budgets,
distances, Ask→Drop/Offer routing, and learned ranking. Because
`lib/engine.js` is pure (no store access, no I/O), it can be lifted
into the central engine unchanged.

## 5. Links and deep links

- The footer links out today: Travelers app (`app.raahi.io`), Experts
  and `raahi.io` (the Expert *store* URLs slot into
  `lib/config.js → LINKS.expertApp` when they exist; until then the
  link points at raahi.io).
- Deep-link scheme reserved for NOW: **`raahi-now://`** — so the
  traveler/expert apps can hand a user straight into a Drop, Offer, or
  Event later (e.g. `raahi-now://drop/<id>`).

## What is deliberately NOT done

- No Firebase switch, no shared login, no calls to the main app's API,
  no bookings leaving NOW, no auto-posting actually firing. All of
  those are product decisions for Imesh, gated on the QA items in the
  Nov 14 report (B1–B4 class) staying green.
