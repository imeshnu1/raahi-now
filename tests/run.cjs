// Raahi NOW — full local test suite (fallback JSON store, fresh DB).
//
// Run:  npm test        (or: node tests/run.cjs)
//
// What it does:
//  - static checks: node --check on every JS file, seed.json validity,
//    styles.css palette audit (only the 5 brand hexes), the
//    .modal-backdrop[hidden] regression rule, api/ function count ≤ 12.
//  - boots server.js on a test port against a FRESH data/dev-db.json
//    (an existing dev DB is backed up and restored afterwards),
//  - runs the v2 feature tests (offers, buddies, events, share outbox,
//    tips, Izzy matches, offer bookings, pickup location), the payment
//    methods reset (US dollars first, small crypto set), the social
//    engine drain endpoints (token-gated outbox), the social poster
//    worker (tools/social-poster.mjs, dry-run + token refusal), and the
//    core regression set (auth gate, per-user wallet, unlock, QA B4–B9),
//  - prints PASS/FAIL per check and exits non-zero on any failure.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const DB_PATH = path.join(ROOT, 'data', 'dev-db.json');
const BAK_PATH = `${DB_PATH}.testbak`;

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

// ---------- static checks ----------
function staticChecks() {
  const jsFiles = [];
  for (const dir of ['lib', 'api', 'tests']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith('.js') || f.endsWith('.cjs')) jsFiles.push(path.join(dir, f));
  }
  jsFiles.push('server.js', path.join('public', 'main.js'));
  let allParse = true;
  for (const f of jsFiles) {
    const r = spawnSync('node', ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    if (r.status !== 0) { allParse = false; console.log(`  parse fail: ${f}: ${r.stderr.split('\n')[0]}`); }
  }
  check('static: all JS files parse (node --check)', allParse, `${jsFiles.length} files`);

  let seedOk = false;
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed.json'), 'utf8'));
    seedOk = Array.isArray(seed.drops) && seed.drops.length === 6
      && Array.isArray(seed.events) && seed.events.some((e) => e.name === "Tamara's Cheese Tasting" && e.marketId === 'ellsworth');
  } catch { /* stays false */ }
  check('static: seed.json valid, 6 Drops + Tamara cheese event', seedOk);

  let methodIds = [];
  try {
    methodIds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed.json'), 'utf8')).paymentMethods.map((m) => m.id);
  } catch { /* stays empty */ }
  check('static: paymentMethods exactly [usd, credits, ninjji, jellyjelly, wobbles, sol, usdc] (US dollars first)',
    JSON.stringify(methodIds) === JSON.stringify(['usd', 'credits', 'ninjji', 'jellyjelly', 'wobbles', 'sol', 'usdc']),
    methodIds.join(','));

  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const palette = new Set(['#1A1A1A', '#FFFFFF', '#E8926A', '#F4EFEA', '#6B6B6B']);
  const hexes = new Set([...css.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0].toUpperCase()));
  check('static: styles.css uses only the 5 palette hexes', [...hexes].every((h) => palette.has(h)), [...hexes].join(' '));
  check('static: .modal-backdrop[hidden]{display:none} rule present',
    /\.modal-backdrop\[hidden\]\s*\{\s*display:\s*none/.test(css));

  const apiCount = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length;
  check('static: api/ function count ≤ 12 (Hobby limit)', apiCount <= 12, `${apiCount} files`);
}

// ---------- tiny HTTP client with cookie jar ----------
async function call(method, p, { body, cookie, headers } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/markets`); if (r.ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function apiTests() {
  // --- accounts ---
  const a = await call('POST', '/api/signup', { body: { name: 'Hannah Host', email: 'hannah@test.dev', password: 'password123' } });
  check('signup A → 201 + starting wallet 12', a.status === 201 && a.data.wallet && a.data.wallet.creditsBalance === 12);
  const cookieA = a.cookie;
  const b = await call('POST', '/api/signup', { body: { name: 'Tom Traveler', email: 'tom@test.dev', password: 'password123' } });
  check('signup B → 201', b.status === 201);
  const cookieB = b.cookie;

  const me = await call('GET', '/api/me', { cookie: cookieB });
  check('/api/me includes externalId (null for now)', me.status === 200 && 'externalId' in me.data.user && me.data.user.externalId === null);
  check('wallet payload currencies == [USD] (US dollars only for now)',
    JSON.stringify(a.data.wallet && a.data.wallet.currencies) === JSON.stringify(['USD']),
    JSON.stringify(a.data.wallet && a.data.wallet.currencies));
  check('wallet payload paymentMethods start with US dollars',
    !!a.data.wallet && Array.isArray(a.data.wallet.paymentMethods) && a.data.wallet.paymentMethods[0].id === 'usd' && a.data.wallet.paymentMethods[0].label === 'US dollars');

  // --- offers ---
  const guestOffer = await call('POST', '/api/offers', { body: { name: 'Guest Gail', marketId: 'nyc', title: 'I have 2 hours to show you around', detail: 'Regular person, not a guide. 2 spots in my car.', whenText: 'Tomorrow, 10 am', spots: 2, priceCredits: 10 } });
  check('guest offer post → 201 + claim token present', guestOffer.status === 201 && !!guestOffer.data.claimToken && guestOffer.data.offer.posterName === 'Guest Gail',
    guestOffer.status !== 201 ? JSON.stringify(guestOffer.data) : undefined);
  const guestOfferId = guestOffer.data.offer && guestOffer.data.offer.id;

  const ownOffer = await call('POST', '/api/offers', { cookie: cookieA, body: { marketId: 'nyc', title: 'Morning walk in the park', detail: 'Easy pace, good coffee after.', whenText: 'Sunday 9 am', spots: 3, priceCredits: 0 } });
  check('logged-in offer → 201, no claim token, linked message', ownOffer.status === 201 && !ownOffer.data.claimToken && /linked to your account/.test(ownOffer.data.message || ''));
  const ownOfferId = ownOffer.data.offer && ownOffer.data.offer.id;

  const offersForA = await call('GET', '/api/offers', { cookie: cookieA });
  const mine = (offersForA.data.offers || []).find((o) => o.id === ownOfferId);
  check('GET /api/offers marks own post (mine) + poster name', !!mine && mine.mine === true && mine.posterName === 'Hannah Host');
  check('public offer shape never includes claimToken', (offersForA.data.offers || []).every((o) => !('claimToken' in o)));

  for (const [label, patch] of [['spots 0', { spots: 0 }], ['spots 21', { spots: 21 }], ['price -1', { priceCredits: -1 }], ['bad market', { marketId: 'nope' }], ['empty title', { title: '' }]]) {
    const r = await call('POST', '/api/offers', { body: { name: 'Val Val', marketId: 'nyc', title: 'T', detail: 'D', spots: 2, priceCredits: 5, ...patch } });
    check(`offer validation: ${label} → 400`, r.status === 400);
  }
  const noName = await call('POST', '/api/offers', { body: { marketId: 'nyc', title: 'T', detail: 'D', spots: 2, priceCredits: 5 } });
  check('guest offer without a name → 400', noName.status === 400);

  // --- buddy posts + responses ---
  const buddy = await call('POST', '/api/buddies', { body: { name: 'Visitor Vic', marketId: 'nyc', title: 'In NYC — looking for a food walk buddy', detail: 'In town two days, love food, no crowds.', whenText: 'Saturday afternoon', party: 2 } });
  check('guest buddy post → 201', buddy.status === 201, buddy.status !== 201 ? JSON.stringify(buddy.data) : undefined);
  const buddyId = buddy.data.buddy && buddy.data.buddy.id;

  const respGuest = await call('POST', '/api/buddy-respond', { body: { buddyId, message: 'I can join!' } });
  check('buddy respond logged-out → 401', respGuest.status === 401);
  const respB = await call('POST', '/api/buddy-respond', { cookie: cookieB, body: { buddyId, message: 'I know just the streets for that.' } });
  check('buddy respond logged-in → 201', respB.status === 201, respB.status !== 201 ? JSON.stringify(respB.data) : undefined);

  const buddies = await call('GET', '/api/buddies');
  const savedBuddy = (buddies.data.buddies || []).find((x) => x.id === buddyId);
  check('GET /api/buddies shows response + responder first name',
    !!savedBuddy && savedBuddy.responseCount === 1 && savedBuddy.responses[0].firstName === 'Tom',
    savedBuddy ? `count=${savedBuddy.responseCount}` : 'buddy missing');

  // --- Izzy matches (slice 1) ---
  check('Izzy match: NYC buddy sees matches ≥ 1 (offers/events there)',
    !!savedBuddy && savedBuddy.matches >= 1, savedBuddy ? `matches=${savedBuddy.matches}` : undefined);
  const guestOfferView = (offersForA.data.offers || []).find((o) => o.id === guestOfferId);
  const offersNow = await call('GET', '/api/offers');
  const guestOfferNow = (offersNow.data.offers || []).find((o) => o.id === guestOfferId);
  check('Izzy match: NYC offer sees matches ≥ 1 (buddy post there)',
    !!guestOfferNow && guestOfferNow.matches >= 1, guestOfferNow ? `matches=${guestOfferNow.matches}` : undefined);
  void guestOfferView;

  // --- events ---
  const ev = await call('POST', '/api/events', { body: { hostName: 'Vendor Vera', marketId: 'ellsworth', name: "Vera's Jam Tasting", detail: 'Small-batch jams, warm bread.', dateText: 'Sun Nov 15, 11 am', placeText: 'Ellsworth farmers market' } });
  check('guest event post → 201 + claim token', ev.status === 201 && !!ev.data.claimToken, ev.status !== 201 ? JSON.stringify(ev.data) : undefined);
  const events = await call('GET', '/api/events');
  const tamara = (events.data.events || []).find((e) => e.name === "Tamara's Cheese Tasting");
  check('GET /api/events includes seeded Tamara event (example: true)',
    !!tamara && tamara.example === true && tamara.marketId === 'ellsworth' && /Downtown Ellsworth/.test(tamara.placeText || ''));
  check('GET /api/events includes the posted event', (events.data.events || []).some((e) => e.name === "Vera's Jam Tasting"));

  // --- share outbox ---
  const share = await call('POST', '/api/share', { body: { kind: 'event', refId: 'event-ellsworth-cheese' } });
  check('share queue → 201 + queued flag', share.status === 201 && share.data.queued === true, share.status !== 201 ? JSON.stringify(share.data) : undefined);
  const shareBad = await call('POST', '/api/share', { body: { kind: 'event', refId: 'nope' } });
  check('share with unknown ref → 404', shareBad.status === 404);
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const outRow = (db.outbox || []).find((o) => o.refId === 'event-ellsworth-cheese');
  check('outbox row persisted (kind event, platform all, status queued)',
    !!outRow && outRow.kind === 'event' && outRow.platform === 'all' && outRow.status === 'queued' && /Raahi NOW/.test(outRow.payload || ''));

  // --- social engine drain (token-gated; harness sets SOCIAL_ENGINE_TOKEN) ---
  const SOCIAL_HDR = { 'x-social-token': 'test-social-token' };
  const outNoTok = await call('GET', '/api/outbox');
  check('GET /api/outbox without token → 401', outNoTok.status === 401);
  const outBadTok = await call('GET', '/api/outbox', { headers: { 'x-social-token': 'wrong-token' } });
  check('GET /api/outbox with wrong token → 401', outBadTok.status === 401);
  const outOk = await call('GET', '/api/outbox', { headers: SOCIAL_HDR });
  const queuedRow = (outOk.data.outbox || []).find((o) => o.id === (share.data && share.data.id));
  check('GET /api/outbox with token → 200 + queued share row present',
    outOk.status === 200 && !!queuedRow && queuedRow.status === 'queued',
    outOk.status !== 200 ? JSON.stringify(outOk.data) : undefined);
  check('queued row carries payloads for all 5 platforms',
    !!queuedRow && ['instagram', 'tiktok', 'youtube', 'reddit', 'facebook'].every((p) => !!queuedRow.payloads && !!queuedRow.payloads[p])
      && /Tamara/.test(queuedRow.payloads.instagram) && /Raahi NOW/.test(queuedRow.payloads.facebook),
    queuedRow && queuedRow.payloads ? Object.keys(queuedRow.payloads).join(',') : 'no payloads');
  check('queued row / response carries the account registry (5 platforms)',
    (Array.isArray(outOk.data.accounts) && outOk.data.accounts.length === 5)
      || (!!queuedRow && Array.isArray(queuedRow.accounts) && queuedRow.accounts.length === 5));

  const updNoTok = await call('POST', '/api/outbox-update', { body: { id: share.data && share.data.id, status: 'posted' } });
  check('POST /api/outbox-update without token → 401', updNoTok.status === 401);
  const updBadStatus = await call('POST', '/api/outbox-update', { headers: SOCIAL_HDR, body: { id: share.data && share.data.id, status: 'bogus' } });
  check('POST /api/outbox-update invalid status → 400', updBadStatus.status === 400);
  const updUnknown = await call('POST', '/api/outbox-update', { headers: SOCIAL_HDR, body: { id: 'out-does-not-exist', status: 'posted' } });
  check('POST /api/outbox-update unknown id → 404', updUnknown.status === 404);
  const upd = await call('POST', '/api/outbox-update', { headers: SOCIAL_HDR, body: { id: share.data && share.data.id, status: 'posted', externalUrl: 'https://instagram.com/p/test123' } });
  check('POST /api/outbox-update posted + externalUrl → 200, row updated',
    upd.status === 200 && upd.data.outbox && upd.data.outbox.status === 'posted'
      && upd.data.outbox.externalUrl === 'https://instagram.com/p/test123' && !!upd.data.outbox.postedAt,
    upd.status !== 200 ? JSON.stringify(upd.data) : undefined);
  const outAfter = await call('GET', '/api/outbox', { headers: SOCIAL_HDR });
  check('posted row no longer in the queued drain list',
    !(outAfter.data.outbox || []).some((o) => o.id === (share.data && share.data.id)));

  const accounts = await call('GET', '/api/social-accounts');
  const igAccount = (accounts.data.accounts || []).find((x) => x.platform === 'instagram');
  check('GET /api/social-accounts → 200, 5 platforms, Instagram connected (@i.travel.with.raahi), other handles null',
    accounts.status === 200 && Array.isArray(accounts.data.accounts) && accounts.data.accounts.length === 5
      && !!igAccount && igAccount.handle === 'i.travel.with.raahi' && igAccount.status === 'connected'
      && accounts.data.accounts.filter((x) => x.platform !== 'instagram').every((x) => x.handle === null)
      && ['instagram', 'tiktok', 'youtube', 'reddit', 'facebook'].every((p) => accounts.data.accounts.some((x) => x.platform === p)),
    accounts.status !== 200 ? JSON.stringify(accounts.data) : undefined);
  check('GET /api/social-accounts never exposes the internal connector account id',
    !JSON.stringify(accounts.data).includes('17841430973767174')
      && (accounts.data.accounts || []).every((x) => !('connectorAccountId' in x)));

  // --- regression: unlock gate + flow (user B balance tracking) ---
  const unlockAnon = await call('POST', '/api/unlock', { body: { dropId: 'drop-kyoto-food', method: 'ninjji' } });
  check('regression: unlock without session → 401', unlockAnon.status === 401);
  const unlock = await call('POST', '/api/unlock', { cookie: cookieB, body: { dropId: 'drop-kyoto-food', method: 'ninjji' } });
  check('regression: unlock succeeds, balance 12 → 10, exactPlace revealed',
    unlock.status === 200 && unlock.data.wallet.creditsBalance === 10 && !!unlock.data.drop.exactPlace,
    unlock.status !== 200 ? JSON.stringify(unlock.data) : undefined);

  // --- tips ---
  const tipAnon = await call('POST', '/api/tip', { body: { kind: 'offer', refId: guestOfferId, amount: 2, method: 'ninjji' } });
  check('tip logged-out → 401', tipAnon.status === 401);
  const tipOwn = await call('POST', '/api/tip', { cookie: cookieA, body: { kind: 'offer', refId: ownOfferId, amount: 2, method: 'ninjji' } });
  check('tip own post → 400', tipOwn.status === 400);
  const tip = await call('POST', '/api/tip', { cookie: cookieB, body: { kind: 'offer', refId: guestOfferId, amount: 3, method: 'ninjji' } });
  check('tip success → 201, wallet debited 10 → 7', tip.status === 201 && tip.data.wallet.creditsBalance === 7,
    tip.status !== 201 ? JSON.stringify(tip.data) : `balance=${tip.data.wallet && tip.data.wallet.creditsBalance}`);
  const walletB = await call('GET', '/api/wallet', { cookie: cookieB });
  check('tip recorded in payments (kind tip)',
    (walletB.data.wallet.payments || []).some((p) => p.kind === 'tip' && p.credits === 3));
  const tipBig = await call('POST', '/api/tip', { cookie: cookieB, body: { kind: 'offer', refId: guestOfferId, amount: 100, method: 'ninjji' } });
  check('tip over balance → 402', tipBig.status === 402);
  const db2 = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  check('tip row persisted with payment id', (db2.tips || []).some((t) => t.kind === 'offer' && t.refId === guestOfferId && t.amountCredits === 3 && !!t.paymentId));

  // --- bookings: pickup location, offer booking, QA regressions ---
  const bk = await call('POST', '/api/bookings', { cookie: cookieB, body: { localId: 'steph', dropId: 'drop-nyc-birds', when: 'Tomorrow 9 am', people: 2, pickupLocation: 'Central Park West & 100th', method: 'ninjji' } });
  check('booking with pickupLocation → 201', bk.status === 201, bk.status !== 201 ? JSON.stringify(bk.data) : undefined);
  const myBookings = await call('GET', '/api/bookings', { cookie: cookieB });
  const savedBk = (myBookings.data.bookings || []).find((x) => x.dropId === 'drop-nyc-birds');
  check('pickupLocation stored + returned on booking', !!savedBk && savedBk.pickupLocation === 'Central Park West & 100th');

  const bkOffer = await call('POST', '/api/bookings', { cookie: cookieB, body: { offerId: guestOfferId, when: 'Tomorrow, 10 am', people: 1, method: 'ninjji' } });
  check('offer booking (Request a spot) → 201 with host name', bkOffer.status === 201 && bkOffer.data.booking.localName === 'Guest Gail',
    bkOffer.status !== 201 ? JSON.stringify(bkOffer.data) : undefined);
  const offersAfter = await call('GET', '/api/offers');
  const guestOfferAfter = (offersAfter.data.offers || []).find((o) => o.id === guestOfferId);
  check('offer spotsTaken 1 / spotsLeft 1 after booking', !!guestOfferAfter && guestOfferAfter.spotsTaken === 1 && guestOfferAfter.spotsLeft === 1,
    guestOfferAfter ? `taken=${guestOfferAfter.spotsTaken} left=${guestOfferAfter.spotsLeft}` : 'offer missing');

  const b5 = await call('POST', '/api/bookings', { cookie: cookieB, body: { localId: 'steph', when: 'x', people: 999 } });
  check('regression B5: booking people 999 → 400', b5.status === 400);
  const b6 = await call('POST', '/api/bookings', { cookie: cookieB, body: { localId: 'marcus', dropId: 'drop-nyc-birds', when: 'x', people: 2 } });
  check('regression B6: booking local ≠ Drop local → 400', b6.status === 400);

  const asks = await call('GET', '/api/asks');
  const seedAsk = (asks.data.asks || []).find((x) => x.marketId === 'nyc');
  const b4 = await call('POST', '/api/answer', { cookie: cookieB, body: { askId: seedAsk && seedAsk.id, localId: 'dula', text: 'Try this.' } });
  check('regression B4: cross-market answer → 400', b4.status === 400);
  const b4ok = await call('POST', '/api/answer', { cookie: cookieB, body: { askId: seedAsk && seedAsk.id, localId: 'steph', text: 'One good idea.' } });
  check('regression B4: same-market answer → 201', b4ok.status === 201);

  const b7 = await call('POST', '/api/topup', { cookie: cookieB, body: { amount: 2.5, method: 'ninjji' } });
  check('regression B7: top-up 2.5 → 400', b7.status === 400);
  const b9 = await call('POST', '/api/topup', { cookie: cookieB, body: { amount: 5 } });
  check('regression B9: top-up with no method → 400', b9.status === 400);
  const b8 = await call('POST', '/api/topup', { cookie: cookieB, body: { amount: 5, method: 'credits' } });
  check('regression B8: top-up with credits → 400', b8.status === 400);

  // --- payment methods reset (US dollars first; small crypto set) ---
  // Runs on user A so user B's tracked balances above stay untouched.
  let allValidTopups = true;
  for (const m of ['usd', 'ninjji', 'jellyjelly', 'wobbles', 'sol', 'usdc']) {
    const r = await call('POST', '/api/topup', { cookie: cookieA, body: { amount: 2, method: m } });
    if (r.status !== 200) { allValidTopups = false; console.log(`  top-up via ${m} → ${r.status} ${JSON.stringify(r.data)}`); }
  }
  check('top-up succeeds with US dollars + all 5 cryptos', allValidTopups);
  let allRemovedRejected = true;
  for (const m of ['btc', 'eth', 'card', 'jpy']) {
    const r = await call('POST', '/api/topup', { cookie: cookieA, body: { amount: 2, method: m } });
    if (r.status !== 400) { allRemovedRejected = false; console.log(`  top-up via removed method ${m} → ${r.status}`); }
  }
  check('top-up with removed methods (btc/eth/card/jpy) → 400 unknown method', allRemovedRejected);
  const unlockSol = await call('POST', '/api/unlock', { cookie: cookieA, body: { dropId: 'drop-nyc-birds', method: 'sol' } });
  check('unlock with SOL → 200', unlockSol.status === 200, unlockSol.status !== 200 ? JSON.stringify(unlockSol.data) : undefined);
  const unlockJelly = await call('POST', '/api/unlock', { cookie: cookieA, body: { dropId: 'drop-boston-rain', method: 'jellyjelly' } });
  check('unlock with JellyJelly → 200', unlockJelly.status === 200, unlockJelly.status !== 200 ? JSON.stringify(unlockJelly.data) : undefined);
  const unlockEth = await call('POST', '/api/unlock', { cookie: cookieA, body: { dropId: 'drop-acadia-sunset', method: 'eth' } });
  check('unlock with removed method (eth) → 400', unlockEth.status === 400);
}

// ---------- social poster worker (tools/social-poster.mjs) ----------
// Runs against the same test server (SOCIAL_ENGINE_TOKEN=test-social-token).
// Dry-run only: the poster must plan the Instagram action for a queued
// Drop row, plan a "no image" failure for a queued Event row, leave the
// outbox untouched, and refuse with the clear 401 message on a wrong or
// missing token. The real CLI is never invoked here.
async function posterTests() {
  const parse = spawnSync('node', ['--check', path.join(ROOT, 'tools', 'social-poster.mjs')], { encoding: 'utf8' });
  check('poster: tools/social-poster.mjs parses (node --check)', parse.status === 0,
    parse.status !== 0 ? (parse.stderr || '').split('\n')[0] : undefined);

  const dropShare = await call('POST', '/api/share', { body: { kind: 'drop', refId: 'drop-nyc-birds' } });
  check('poster setup: drop share queued → 201', dropShare.status === 201 && !!dropShare.data.id,
    dropShare.status !== 201 ? JSON.stringify(dropShare.data) : undefined);
  const eventShare = await call('POST', '/api/share', { body: { kind: 'event', refId: 'event-ellsworth-cheese' } });
  check('poster setup: event share queued → 201', eventShare.status === 201 && !!eventShare.data.id,
    eventShare.status !== 201 ? JSON.stringify(eventShare.data) : undefined);

  const runPoster = (token) => spawnSync('node', [path.join(ROOT, 'tools', 'social-poster.mjs'), '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SOCIAL_ENGINE_TOKEN: token, NOW_BASE_URL: BASE },
  });

  const dry = runPoster('test-social-token');
  const dryOut = `${dry.stdout || ''}\n${dry.stderr || ''}`;
  check('poster --dry-run with token → exit 0', dry.status === 0, dry.status !== 0 ? dryOut.slice(0, 300) : undefined);
  check('poster --dry-run plans the Instagram post for the queued Drop row (image + post-feed)',
    dryOut.includes(dropShare.data.id) && dryOut.includes('instagram-cli post-feed') && dryOut.includes('images.unsplash.com'),
    dryOut.slice(0, 300));
  check('poster --dry-run plans "no image" failure for the queued Event row',
    dryOut.includes(eventShare.data.id) && dryOut.includes('NO IMAGE'), dryOut.slice(0, 300));
  check('poster --dry-run never prints the internal connector account id',
    !dryOut.includes('17841430973767174'));

  const stillQueued = await call('GET', '/api/outbox', { headers: { 'x-social-token': 'test-social-token' } });
  check('poster --dry-run left the outbox untouched (both rows still queued)',
    (stillQueued.data.outbox || []).some((o) => o.id === dropShare.data.id)
      && (stillQueued.data.outbox || []).some((o) => o.id === eventShare.data.id));

  const wrong = runPoster('wrong-token');
  const wrongOut = `${wrong.stdout || ''}\n${wrong.stderr || ''}`;
  check('poster with wrong token → non-zero exit + clear 401 message',
    wrong.status !== 0 && wrongOut.includes('401') && wrongOut.includes('SOCIAL_ENGINE_TOKEN'),
    `exit=${wrong.status} out=${wrongOut.slice(0, 200)}`);

  const missing = runPoster('');
  const missingOut = `${missing.stdout || ''}\n${missing.stderr || ''}`;
  check('poster with missing token → non-zero exit + clear message',
    missing.status !== 0 && missingOut.includes('SOCIAL_ENGINE_TOKEN is missing'),
    `exit=${missing.status} out=${missingOut.slice(0, 200)}`);
}

async function main() {
  staticChecks();

  const hadDb = fs.existsSync(DB_PATH);
  if (hadDb) fs.renameSync(DB_PATH, BAK_PATH);
  const env = { ...process.env, PORT: String(PORT), SOCIAL_ENGINE_TOKEN: 'test-social-token' };
  delete env.DATABASE_URL; // force the local fallback store
  const server = spawn('node', [path.join(ROOT, 'server.js')], { env, stdio: 'pipe' });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  try {
    const ready = await waitReady();
    check('server boots on fallback store', ready, ready ? undefined : serverLog.slice(0, 300));
    if (ready) { await apiTests(); await posterTests(); }
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    if (hadDb && fs.existsSync(BAK_PATH)) fs.renameSync(BAK_PATH, DB_PATH);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('test runner crashed:', e); process.exit(2); });
