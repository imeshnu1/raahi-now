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
//    tips, Izzy matches, offer bookings, pickup location) and the core
//    regression set (auth gate, per-user wallet, unlock, QA B4–B9),
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
async function call(method, p, { body, cookie } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
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
}

async function main() {
  staticChecks();

  const hadDb = fs.existsSync(DB_PATH);
  if (hadDb) fs.renameSync(DB_PATH, BAK_PATH);
  const env = { ...process.env, PORT: String(PORT) };
  delete env.DATABASE_URL; // force the local fallback store
  const server = spawn('node', [path.join(ROOT, 'server.js')], { env, stdio: 'pipe' });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  try {
    const ready = await waitReady();
    check('server boots on fallback store', ready, ready ? undefined : serverLog.slice(0, 300));
    if (ready) await apiTests();
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
