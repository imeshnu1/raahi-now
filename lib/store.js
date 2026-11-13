// Data layer for Raahi NOW (demo).
//
// State lives in memory, seeded from data/seed.json. On Vercel this is a
// per-instance warm store (fine for the demo); locally it lives for the
// life of the server process. To go production, replace the functions in
// this file with calls to a real database (Postgres / Supabase / PlanetScale).
// Nothing outside this file touches raw state, and markets, locals and
// Drops are data — a new country or city is new seed/database rows, not
// new pages or code.

const seed = require('../data/seed.json');

function init() {
  const now = Date.now();
  const drops = seed.drops.map((d) => ({
    ...d,
    expiresAt: new Date(now + d.expiresInMinutes * 60000).toISOString(),
  }));
  const asks = seed.asks.map((a) => ({
    ...a,
    createdAt: a.createdAt || new Date(now).toISOString(),
  }));
  return {
    config: seed.config,
    markets: seed.markets,
    locals: seed.locals,
    paymentMethods: seed.paymentMethods,
    drops,
    asks,
    bookings: [],
    unlockedDropIds: [],
    wallet: {
      creditsBalance: seed.config.startingCredits,
      payments: [], // every demo payment lands here, marked demo: true
    },
    seq: 1,
  };
}

// Keep one store per server / serverless instance.
if (!globalThis.__raahiNowStore) {
  globalThis.__raahiNowStore = init();
}

function store() {
  return globalThis.__raahiNowStore;
}

function nextId(prefix) {
  const s = store();
  s.seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${s.seq}`;
}

function localById(id) {
  return store().locals.find((l) => l.id === id) || null;
}

function marketById(id) {
  return store().markets.find((m) => m.id === id) || null;
}

// Public shape of a Drop: the exact place and meet detail are only
// included once the demo traveller has unlocked it.
function publicDrop(drop) {
  const s = store();
  const unlocked = s.unlockedDropIds.includes(drop.id);
  const unlocksLeft = Math.max(0, drop.unlockCap - drop.unlocksUsed);
  const expired = new Date(drop.expiresAt).getTime() <= Date.now();
  return {
    id: drop.id,
    marketId: drop.marketId,
    local: localById(drop.localId),
    title: drop.title,
    whyNow: drop.whyNow,
    image: drop.image,
    perfectFor: drop.perfectFor,
    costRange: drop.costRange,
    timeNeeded: drop.timeNeeded,
    warning: drop.warning,
    priceCredits: drop.priceCredits,
    fuzzyLocation: drop.fuzzyLocation,
    expiresAt: drop.expiresAt,
    unlockCap: drop.unlockCap,
    unlocksUsed: drop.unlocksUsed,
    unlocksLeft,
    illustrative: !!drop.illustrative,
    unlocked,
    closed: expired || unlocksLeft <= 0,
    status: expired ? 'expired' : unlocksLeft <= 0 ? 'full' : 'live',
    exactPlace: unlocked ? drop.exactPlace : null,
    meetDetail: unlocked ? drop.meetDetail : null,
  };
}

function publicAsk(ask) {
  return {
    ...ask,
    market: marketById(ask.marketId),
    answers: (ask.answers || []).map((a) => ({ ...a, local: localById(a.localId) })),
  };
}

function recordDemoPayment(kind, method, credits, detail) {
  const s = store();
  const payment = {
    id: nextId('pay'),
    kind,
    method,
    credits,
    detail: detail || '',
    demo: true,
    createdAt: new Date().toISOString(),
  };
  s.wallet.payments.unshift(payment);
  return payment;
}

module.exports = { store, nextId, localById, marketById, publicDrop, publicAsk, recordDemoPayment };
