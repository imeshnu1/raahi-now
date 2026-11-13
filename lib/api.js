// Shared API handlers for Raahi NOW.
// Used both by the local server (server.js) and by the Vercel serverless
// functions in /api — one implementation, two runtimes.
//
// AUTH: real accounts (lib/auth.js) + persistent store (lib/store.js).
// Public: browsing Drops and markets, reading Asks.
// Login required (401 JSON when there is no valid session): unlock,
// posting/answering Asks, bookings, wallet, top-up, wallet-address.
//
// PAYMENTS: all charges go through the provider abstraction in
// lib/payments.js. In this build the provider is the DEMO provider:
// no real money moves, no processor is called, every record is marked
// demo. Methods stay open and currency-agnostic: Ninjji (native,
// preferred), credits, BTC, ETH, USDC, card, fiat USD/JPY/LKR.

const store = require('./store');
const { backend } = store;
const auth = require('./auth');
const payments = require('./payments');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function walletView(userId) {
  return {
    creditsBalance: await backend.walletBalance(userId),
    payments: await backend.listPayments(userId),
    demo: true,
    currencies: ['USD', 'JPY', 'LKR'],
    paymentMethods: store.paymentMethods,
  };
}

async function dropView(drop, userId) {
  const state = await backend.dropState(drop.id);
  const unlockedIds = userId ? await backend.unlockedIds(userId) : [];
  return store.publicDrop(drop, state.used, unlockedIds.includes(drop.id), state.expiresAt);
}

const EMAIL_RE = /^\S+@\S+\.\S+$/;

async function handle(req, res, action) {
  const url = new URL(req.url, 'http://localhost');
  try {
    const user = await auth.currentUser(req).catch(() => null);
    const requireUser = () => {
      if (!user) { sendJson(res, 401, { error: 'Log in or create an account to continue', code: 'AUTH_REQUIRED' }); return false; }
      return true;
    };

    // ---------- Auth ----------
    if (action === 'me' && req.method === 'GET') {
      if (!user) return sendJson(res, 401, { error: 'Not logged in', user: null });
      return sendJson(res, 200, { user: auth.publicUser(user) });
    }

    if (action === 'signup' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!name) return sendJson(res, 400, { error: 'Your name is required' });
      if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: 'Enter a valid email address' });
      if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
      let created;
      try {
        created = await backend.createUser({ name, email, passwordHash: await auth.hashPassword(password) });
      } catch (e) {
        if (e.code === 'DUPLICATE_EMAIL') return sendJson(res, 409, { error: 'An account with this email already exists. Log in instead.' });
        throw e;
      }
      await auth.startSession(req, res, created.id);
      const fresh = await backend.getUserById(created.id);
      return sendJson(res, 201, { user: auth.publicUser(fresh), wallet: await walletView(created.id) });
    }

    if (action === 'login' && req.method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const found = email ? await backend.getUserByEmail(email) : null;
      if (!found || !(await auth.verifyPassword(password, found.passwordHash))) {
        return sendJson(res, 401, { error: 'Invalid email or password' });
      }
      await auth.startSession(req, res, found.id);
      const fresh = await backend.getUserById(found.id);
      return sendJson(res, 200, { user: auth.publicUser(fresh), wallet: await walletView(found.id) });
    }

    if (action === 'logout' && req.method === 'POST') {
      await auth.endSession(req, res);
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'wallet-address' && req.method === 'POST') {
      if (!requireUser()) return;
      const body = await readBody(req);
      const address = String(body.address || '').trim();
      if (address.length < 8 || address.length > 128 || /\s/.test(address)) {
        return sendJson(res, 400, { error: 'Enter a valid wallet address' });
      }
      await backend.setWalletAddress(user.id, address);
      const fresh = await backend.getUserById(user.id);
      return sendJson(res, 200, { user: auth.publicUser(fresh), walletAddress: address });
    }

    // ---------- Public content ----------
    if (action === 'markets' && req.method === 'GET') {
      return sendJson(res, 200, { markets: store.markets, config: store.config, paymentMethods: store.paymentMethods, demo: true });
    }

    if (action === 'drops' && req.method === 'GET') {
      const market = url.searchParams.get('market');
      const filtered = store.drops.filter((d) => !market || market === 'all' || d.marketId === market);
      const drops = [];
      for (const d of filtered) drops.push(await dropView(d, user ? user.id : null));
      return sendJson(res, 200, { drops, markets: store.markets, demo: true });
    }

    if (action === 'asks' && req.method === 'GET') {
      const asks = (await backend.listAsks()).map(store.publicAsk);
      return sendJson(res, 200, { asks, demo: true });
    }

    // ---------- Login-gated actions ----------
    if (action === 'unlock' && req.method === 'POST') {
      if (!requireUser()) return;
      const body = await readBody(req);
      const drop = store.drops.find((d) => d.id === body.dropId);
      if (!drop) return sendJson(res, 404, { error: 'Drop not found' });
      const view = await dropView(drop, user.id);
      if (view.unlocked) return sendJson(res, 200, { drop: view, alreadyUnlocked: true, wallet: await walletView(user.id) });
      if (view.status !== 'live') return sendJson(res, 409, { error: `Drop is ${view.status}` });
      const method = body.method || 'ninjji';
      if (!store.paymentMethods.some((m) => m.id === method)) {
        return sendJson(res, 400, { error: 'Unknown payment method' });
      }
      const balance = await backend.walletBalance(user.id);
      if (balance < drop.priceCredits) {
        return sendJson(res, 402, { error: 'Not enough demo credits. Top up the wallet first.' });
      }
      await backend.addWallet(user.id, -drop.priceCredits);
      await backend.addUnlock(user.id, drop.id, method);
      await backend.bumpDropUsed(drop.id);
      await payments.getProvider().createCharge({
        userId: user.id, kind: 'unlock', amountCredits: drop.priceCredits, method,
        detail: drop.title, walletAddress: user.walletAddress || body.walletAddress || null,
      });
      return sendJson(res, 200, { drop: await dropView(drop, user.id), wallet: await walletView(user.id) });
    }

    if (action === 'asks' && req.method === 'POST') {
      if (!requireUser()) return;
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'An Ask needs a request' });
      if (!store.markets.some((m) => m.id === body.marketId)) {
        return sendJson(res, 400, { error: 'Unknown market' });
      }
      const price = store.config.askPriceCredits;
      const method = body.method || 'ninjji';
      if (!store.paymentMethods.some((m) => m.id === method)) {
        return sendJson(res, 400, { error: 'Unknown payment method' });
      }
      const balance = await backend.walletBalance(user.id);
      if (balance < price) {
        return sendJson(res, 402, { error: 'Not enough demo credits for an Ask. Top up first.' });
      }
      await backend.addWallet(user.id, -price);
      const ask = {
        id: store.genId('ask'),
        userId: user.id,
        marketId: body.marketId,
        text,
        budget: String(body.budget || ''),
        hours: String(body.hours || ''),
        authorName: user.name,
        createdAt: new Date().toISOString(),
        answers: [],
      };
      await backend.createAsk(ask);
      await payments.getProvider().createCharge({
        userId: user.id, kind: 'ask', amountCredits: price, method,
        detail: text.slice(0, 80), walletAddress: user.walletAddress || body.walletAddress || null,
      });
      const saved = (await backend.listAsks()).find((a) => a.id === ask.id) || ask;
      return sendJson(res, 201, { ask: store.publicAsk(saved), wallet: await walletView(user.id) });
    }

    if (action === 'answer' && req.method === 'POST') {
      if (!requireUser()) return;
      const body = await readBody(req);
      const askRow = await backend.getAsk(body.askId);
      if (!askRow) return sendJson(res, 404, { error: 'Ask not found' });
      const local = store.localById(body.localId);
      const text = String(body.text || '').trim();
      if (!local || !text) return sendJson(res, 400, { error: 'Pick a local and write one recommendation' });
      // QA B4 (technical slice): a local may only answer Asks in their own market.
      if (local.marketId !== askRow.marketId) {
        return sendJson(res, 400, { error: 'That local is in a different market and cannot answer this Ask' });
      }
      await backend.addAnswer(body.askId, { localId: local.id, text, createdAt: new Date().toISOString() });
      const saved = (await backend.listAsks()).find((a) => a.id === body.askId);
      return sendJson(res, 201, { ask: saved ? store.publicAsk(saved) : null });
    }

    if (action === 'bookings' && req.method === 'GET') {
      if (!requireUser()) return;
      const bookings = (await backend.listBookings(user.id)).map((b) => ({ ...b, local: store.localById(b.localId) }));
      return sendJson(res, 200, { bookings, demo: true });
    }

    if (action === 'bookings' && req.method === 'POST') {
      if (!requireUser()) return;
      const body = await readBody(req);
      const local = store.localById(body.localId);
      if (!local) return sendJson(res, 400, { error: 'Unknown local' });
      const when = String(body.when || '').trim();
      if (!when) return sendJson(res, 400, { error: 'Tell the local when' });
      // QA B5: headcount must be a whole number between 1 and 12.
      const people = Number(body.people);
      if (!Number.isInteger(people) || people < 1 || people > 12) {
        return sendJson(res, 400, { error: 'People must be a whole number between 1 and 12' });
      }
      // QA B6: a booking made from a Drop must be for that Drop's local.
      if (body.dropId) {
        const drop = store.drops.find((d) => d.id === body.dropId);
        if (!drop || drop.localId !== local.id) {
          return sendJson(res, 400, { error: 'That Drop belongs to a different local' });
        }
      }
      const booking = {
        id: store.genId('booking'),
        userId: user.id,
        localId: local.id,
        dropId: body.dropId || null,
        when,
        people,
        method: body.method || 'ninjji',
        status: 'waiting for confirmation',
        demo: true,
        createdAt: new Date().toISOString(),
      };
      await backend.createBooking(booking);
      return sendJson(res, 201, { booking: { ...booking, local }, bookings: await backend.listBookings(user.id) });
    }

    if (action === 'wallet' && req.method === 'GET') {
      if (!requireUser()) return;
      return sendJson(res, 200, { wallet: await walletView(user.id), user: auth.publicUser(user) });
    }

    if (action === 'topup' && req.method === 'POST') {
      if (!requireUser()) return;
      const body = await readBody(req);
      const amount = Number(body.amount || 0);
      // QA B9: a payment method must be sent explicitly — no silent default.
      const method = String(body.method || '').trim();
      if (!method) return sendJson(res, 400, { error: 'Choose a payment method for the top-up' });
      // QA B8 (technical slice): credits cannot buy credits.
      if (method === 'credits') {
        return sendJson(res, 400, { error: 'You cannot top up with credits. Choose Ninjji, another crypto, card, or fiat.' });
      }
      if (!store.paymentMethods.some((m) => m.id === method)) {
        return sendJson(res, 400, { error: 'Unknown payment method' });
      }
      // QA B7: whole numbers only, keeping the 1–1000 range.
      if (!Number.isInteger(amount) || amount <= 0 || amount > 1000) {
        return sendJson(res, 400, { error: 'Top-up amount must be a whole number between 1 and 1000 demo credits' });
      }
      await backend.addWallet(user.id, amount);
      await payments.getProvider().createCharge({
        userId: user.id, kind: 'topup', amountCredits: amount, method,
        detail: 'Demo wallet top-up', walletAddress: user.walletAddress || body.walletAddress || null,
      });
      return sendJson(res, 200, { wallet: await walletView(user.id), message: `Added ${amount} demo credits via ${method}. No real money moved.` });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 500, { error: 'Server error', detail: String(err && err.message || err) });
  }
}

module.exports = { handle };
