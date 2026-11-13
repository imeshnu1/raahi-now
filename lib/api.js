// Shared API handlers for Raahi NOW.
// Used both by the local server (server.js) and by the Vercel serverless
// functions in /api — one implementation, two runtimes.
//
// ALL payments are DEMO: no real money moves, no payment SDK is called.
// A "payment" here just records the chosen currency-agnostic method and
// moves demo credits in the demo wallet.

const { store, nextId, localById, publicDrop, publicAsk, recordDemoPayment } = require('./store');

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

function walletView() {
  const s = store();
  return {
    creditsBalance: s.wallet.creditsBalance,
    payments: s.wallet.payments,
    demo: true,
    currencies: ['USD', 'JPY', 'LKR'],
    paymentMethods: s.paymentMethods,
  };
}

async function handle(req, res, action) {
  const s = store();
  const url = new URL(req.url, 'http://localhost');
  try {
    if (action === 'markets' && req.method === 'GET') {
      return sendJson(res, 200, { markets: s.markets, config: s.config, demo: true });
    }

    if (action === 'drops' && req.method === 'GET') {
      const market = url.searchParams.get('market');
      const drops = s.drops
        .filter((d) => !market || market === 'all' || d.marketId === market)
        .map(publicDrop);
      return sendJson(res, 200, { drops, markets: s.markets, demo: true });
    }

    if (action === 'unlock' && req.method === 'POST') {
      const body = await readBody(req);
      const drop = s.drops.find((d) => d.id === body.dropId);
      if (!drop) return sendJson(res, 404, { error: 'Drop not found' });
      const view = publicDrop(drop);
      if (view.unlocked) return sendJson(res, 200, { drop: view, alreadyUnlocked: true, wallet: walletView() });
      if (view.status !== 'live') return sendJson(res, 409, { error: `Drop is ${view.status}` });
      const method = body.method || 'ninjji';
      if (!s.paymentMethods.some((m) => m.id === method)) {
        return sendJson(res, 400, { error: 'Unknown payment method' });
      }
      if (s.wallet.creditsBalance < drop.priceCredits) {
        return sendJson(res, 402, { error: 'Not enough demo credits. Top up the wallet first.' });
      }
      s.wallet.creditsBalance -= drop.priceCredits;
      drop.unlocksUsed += 1;
      s.unlockedDropIds.push(drop.id);
      recordDemoPayment('unlock', method, drop.priceCredits, drop.title);
      return sendJson(res, 200, { drop: publicDrop(drop), wallet: walletView() });
    }

    if (action === 'asks' && req.method === 'GET') {
      return sendJson(res, 200, { asks: s.asks.map(publicAsk), demo: true });
    }

    if (action === 'asks' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'An Ask needs a request' });
      if (!s.markets.some((m) => m.id === body.marketId)) {
        return sendJson(res, 400, { error: 'Unknown market' });
      }
      const price = s.config.askPriceCredits;
      const method = body.method || 'ninjji';
      if (s.wallet.creditsBalance < price) {
        return sendJson(res, 402, { error: 'Not enough demo credits for an Ask. Top up first.' });
      }
      s.wallet.creditsBalance -= price;
      const ask = {
        id: nextId('ask'),
        marketId: body.marketId,
        text,
        budget: String(body.budget || ''),
        hours: String(body.hours || ''),
        traveller: 'Demo traveller',
        createdAt: new Date().toISOString(),
        answers: [],
      };
      s.asks.unshift(ask);
      recordDemoPayment('ask', method, price, text.slice(0, 80));
      return sendJson(res, 201, { ask: publicAsk(ask), wallet: walletView() });
    }

    if (action === 'answer' && req.method === 'POST') {
      const body = await readBody(req);
      const ask = s.asks.find((a) => a.id === body.askId);
      if (!ask) return sendJson(res, 404, { error: 'Ask not found' });
      const local = localById(body.localId);
      const text = String(body.text || '').trim();
      if (!local || !text) return sendJson(res, 400, { error: 'Pick a local and write one recommendation' });
      ask.answers.push({ localId: local.id, text, createdAt: new Date().toISOString() });
      return sendJson(res, 201, { ask: publicAsk(ask) });
    }

    if (action === 'bookings' && req.method === 'GET') {
      const bookings = s.bookings.map((b) => ({ ...b, local: localById(b.localId) }));
      return sendJson(res, 200, { bookings, demo: true });
    }

    if (action === 'bookings' && req.method === 'POST') {
      const body = await readBody(req);
      const local = localById(body.localId);
      if (!local) return sendJson(res, 400, { error: 'Unknown local' });
      const when = String(body.when || '').trim();
      if (!when) return sendJson(res, 400, { error: 'Tell the local when' });
      const booking = {
        id: nextId('booking'),
        localId: local.id,
        dropId: body.dropId || null,
        when,
        people: Number(body.people || 1),
        method: body.method || 'ninjji',
        status: 'waiting for confirmation',
        demo: true,
        createdAt: new Date().toISOString(),
      };
      s.bookings.unshift(booking);
      return sendJson(res, 201, { booking: { ...booking, local }, bookings: s.bookings });
    }

    if (action === 'wallet' && req.method === 'GET') {
      return sendJson(res, 200, { wallet: walletView() });
    }

    if (action === 'topup' && req.method === 'POST') {
      const body = await readBody(req);
      const amount = Number(body.amount || 0);
      const method = body.method || 'ninjji';
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) {
        return sendJson(res, 400, { error: 'Top-up amount must be between 1 and 1000 demo credits' });
      }
      if (!s.paymentMethods.some((m) => m.id === method)) {
        return sendJson(res, 400, { error: 'Unknown payment method' });
      }
      s.wallet.creditsBalance += amount;
      recordDemoPayment('topup', method, amount, 'Demo wallet top-up');
      return sendJson(res, 200, { wallet: walletView(), message: `Added ${amount} demo credits via ${method}. No real money moved.` });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 500, { error: 'Server error', detail: String(err && err.message || err) });
  }
}

module.exports = { handle };
