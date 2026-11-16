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
| `method` | payment method | Open set (US dollars, credits, Ninjji, JellyJelly, Wobbles, SOL, USDC); the main app's checkout is real-currency — settlement mapping is a product decision, not a code problem |
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

### Social engine connection (backend — ready now)

The drain API already exists, behind the existing `api/engage.js`
function (rewrites in `vercel.json`; no extra serverless functions):

| Endpoint | Method | Auth | What it does |
|---|---|---|---|
| `/api/outbox` | GET | `x-social-token` header | Queued rows (`status = 'queued'`), **oldest first**. Each row is enriched with `item` (the resolved post snapshot — title, detail, market, and `image`, the photo URL when the post has one), `payloads` — the per-platform post text from `lib/social.js → buildPayloads(item)` — and `accounts`, the account registry (below). |
| `/api/outbox-update` | POST | `x-social-token` header | Body `{ id, status: 'posted' \| 'failed', externalUrl?, note? }`. A `posted` update stamps `posted_at` and stores `externalUrl`; a `failed` update stores `note` in `fail_note`. Invalid status → 400, unknown id → 404. Returns the updated row. |
| `/api/social-accounts` | GET | public | The account registry: platform, handle (null until that platform is provided), status, formats. |

**Auth:** both drain endpoints require the header
`x-social-token: <SOCIAL_ENGINE_TOKEN>`. The token is the
`SOCIAL_ENGINE_TOKEN` environment variable — set it in the Vercel
project (Production) **and** in the social-pilot's environment on the
Mac mini, to the same value. If the env var is unset on the server,
the drain endpoints return 401 for everyone: closed by default.

**Statuses:** an outbox row starts at `queued` → the engine moves it
to exactly one of `posted` (with `external_url` + `posted_at`) or
`failed` (with `fail_note`). Posted/failed rows no longer appear in
`GET /api/outbox`.

**Account registry:** `lib/social.js → ACCOUNTS` — instagram, tiktok,
youtube, reddit, facebook, each with its post formats. **Instagram is
connected: @i.travel.with.raahi** (verified live via the Instagram
connector, 2026-11-15; the registry also carries its internal
connector account id for the posting engine — never user-facing). The
other four platforms are still `handle: null`, status
`awaiting accounts from Imesh`, until those accounts are handed over.

**Poster worker (v1, in this repo):** `tools/social-poster.mjs`
(`npm run poster -- --dry-run` to preview) drains the queue over this
same API and posts to Instagram via the instagram-cli connector:
one platform per row (rows queued as `all` go to Instagram; rows for
other platforms are left queued), the item's image is downloaded to
`~/workspace/social-queue/`, and a row with no image is marked
`failed` with the note "no image available for Instagram yet". It
reads `SOCIAL_ENGINE_TOKEN` and `NOW_BASE_URL` from the environment
or the repo's `.env.local`. The Mac-mini social-pilot can replace or
complement it later without any API change.

**Remaining steps to switch the drain on:**

1. ~~In `lib/social.js`, fill each platform's `handle` and flip its
   `status` to `connected`.~~ Done for Instagram (2026-11-15); repeat
   per platform as the other accounts arrive, then deploy (normal
   GitHub → Vercel flow).
2. **Still pending:** set `SOCIAL_ENGINE_TOKEN` in Vercel (Production
   env) and in the poster's / social-pilot's environment — same value
   both sides. Until this is done the live drain returns 401 for
   everyone, by design.
3. The poster (or social-pilot) polls `GET https://now.raahi.io/api/outbox` with
   the `x-social-token` header every N minutes (suggest 15), takes
   the oldest queued rows first, and posts each row's `payloads` for
   its platform(s) to the connected account.
4. After each post it calls `POST /api/outbox-update` with
   `{ id, status: 'posted', externalUrl }`, or
   `{ id, status: 'failed', note }` when a post fails so a human can
   see why.

Nothing in NOW changes when this goes live — the UI already says
"Queued", and queued rows simply start draining.

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

## 6. Distribution strategy — post once on Raahi, appear everywhere

The point of NOW's social distribution: a vendor, local, or traveler
posts **once**, on Raahi, and the post travels for them. Nobody should
have to re-post the same thing on five platforms by hand.

### Tier 1 — Raahi posts it, with the poster tagged (LIVE)

- Every Offer, Buddy post, and Event can carry the poster's Instagram
  handle: an optional field on the posting forms ("Your Instagram @ —
  we'll tag you when this goes out"), or the handle saved on their
  profile (below). Handles are normalized on the way in (leading `@`
  stripped, simple handle pattern validated) and stored without `@`:
  `socials: { instagram }` JSON on `offers` / `buddy_posts` / `events`
  (Neon TEXT column, file-store object). Drops carry an optional
  `instagram` field in the seed shape for the same purpose (all null
  today — no invented handles for the seeded locals).
- A logged-in member saves their handles once — `POST
  /api/me-socials` (rides `api/auth.js` via a `vercel.json` rewrite;
  body `{ instagram?, tiktok?, youtube? }`, stored as `users.socials`
  JSON, returned on `/api/me`). When they post without typing a
  handle, the post defaults to the profile's Instagram handle; an
  explicit handle on the post always wins.
- When a post is queued and drained, `lib/social.js → buildPayloads`
  attributes it: the Instagram caption gains **"Posted by @handle on
  Raahi NOW"** and the payload carries `tagHandle`. Other platforms
  get the plain version — **"Posted by \<name\> on Raahi NOW"** — an
  @handle is only ever used on the platform it belongs to (v1 collects
  Instagram handles only).
- The poster worker (`tools/social-poster.mjs`) adds the **photo
  tag** on top of the caption tag: it resolves the handle with
  `instagram-cli profile --username <handle>` (returned username must
  match, id must be numeric) and passes `--mentions
  [{"user_fbid":…,"x":0.5,"y":0.5}]` to `post-feed`. A photo tag is
  what puts the post in front of the poster's own audience (their
  tagged photos / timeline), not just Raahi's followers. Resolution is
  best-effort — if it fails, the post still goes out with the caption
  @tag; a post never fails over tagging.
- **Instagram collab-post invites are not available through the
  current connector**, so tagging (caption + photo tag) is the
  mechanism today. If the connector gains collab invites later, Tier 1
  upgrades in the poster worker only — payloads already carry
  everything needed.

### Tier 2 — cross-posting INTO the poster's own accounts (DESIGNED, not built)

The end state: the same post also appears **on the poster's own
accounts**, posted as them, with no extra work for them. That requires
the poster to connect their social account to Raahi (OAuth / Meta
account linking + per-platform posting permissions) — you cannot post
as someone without their grant, and there is no honest shortcut.

- **Data model is ready:** `users.socials` (profile handles),
  per-post `socials` (the handle a specific post carries), and the
  outbox/payload pipeline (`tagHandle` + per-platform copy) all exist.
  A connection adds one thing: a per-user, per-platform connection
  record (provider, external account id, token reference, scopes,
  status) next to `users.socials`.
- **Next build, when prioritized:** the connection flow (link account
  from the "Your socials" card in the Wallet tab), then a second drain
  pass in the posting engine that posts a member's queued items to
  their own connected accounts as well as Raahi's, marking each
  destination separately in the outbox result. Until then, Tier 1
  tagging is the distribution members get — and the UI copy says
  exactly that ("we'll tag you"), nothing more.

## What is deliberately NOT done

- No Firebase switch, no shared login, no calls to the main app's API,
  no bookings leaving NOW, no auto-posting actually firing. All of
  those are product decisions for Imesh, gated on the QA items in the
  Nov 14 report (B1–B4 class) staying green.
