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
// demo. Methods (seed.json paymentMethods): US dollars first, then
// Raahi Credits, then a small crypto set — Ninjji (native, preferred),
// JellyJelly, Wobbles, SOL, USDC.

const store = require('./store');
const { backend } = store;
const auth = require('./auth');
const payments = require('./payments');
const engine = require('./engine');
const social = require('./social');

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
    currencies: ['USD'],
    paymentMethods: store.paymentMethods,
  };
}

async function dropView(drop, userId) {
  const state = await backend.dropState(drop.id);
  const unlockedIds = userId ? await backend.unlockedIds(userId) : [];
  return store.publicDrop(drop, state.used, unlockedIds.includes(drop.id), state.expiresAt);
}

const EMAIL_RE = /^\S+@\S+\.\S+$/;

// ---------- v2 helpers: two-sided posting ----------

// Who is posting? A logged-in user posts as themselves; a guest posts
// under a display name and (for offers/events) gets a one-time claim
// token so the post can later be linked to a Raahi Expert account —
// that's how a guest poster starts getting paid.
function posterIdentity(user, body) {
  if (user) return { userId: user.id, guestName: null, posterName: user.name };
  const name = String(body.name || '').trim();
  if (!name) return null;
  return { userId: null, guestName: name, posterName: name };
}

function newClaimToken() {
  return store.genId('claim').split('-')[2].toUpperCase();
}

function wholeInRange(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

async function allEvents() {
  const posted = await backend.listEvents();
  return [...posted, ...store.seedEvents()];
}

function sharePayload(title, marketId) {
  const m = store.marketById(marketId);
  const where = m ? `${m.city}, ${m.country}` : '';
  return `${title}${where ? ` — ${where}` : ''}. Real locals. Real places. — Raahi NOW · now.raahi.io`;
}

// Resolve a shareable post to the normalized shape the social layer
// (lib/social.js buildPayloads) works from. Events carry their title
// in `name`; everything else uses `title`. `image` is the post's photo
// URL when it has one (Drops do; offers/events/buddies usually don't)
// — the posting worker needs it for image-first platforms.
async function resolveShareItem(kind, refId) {
  if (kind === 'drop') {
    const d = store.drops.find((x) => x.id === refId);
    return d ? { kind, title: d.title, detail: d.whyNow || '', whenText: '', marketId: d.marketId, image: d.image || null } : null;
  }
  if (kind === 'offer') {
    const o = await backend.getOffer(refId);
    return o ? { kind, title: o.title, detail: o.detail || '', whenText: o.whenText || '', marketId: o.marketId, image: o.image || null } : null;
  }
  if (kind === 'event') {
    const e = (await allEvents()).find((x) => x.id === refId);
    return e ? { kind, title: e.name, detail: e.detail || '', whenText: e.dateText || '', marketId: e.marketId, image: e.image || null } : null;
  }
  if (kind === 'buddy') {
    const b = await backend.getBuddy(refId);
    return b ? { kind, title: b.title, detail: b.detail || '', whenText: b.whenText || '', marketId: b.marketId, image: b.image || null } : null;
  }
  return null;
}

// The social engine (the Mac-mini social-pilot) authenticates with a
// shared secret sent in the x-social-token header. When
// SOCIAL_ENGINE_TOKEN is not configured on the server, the drain
// endpoints stay closed — 401 for everyone, token or not.
function socialTokenOk(req) {
  const expected = process.env.SOCIAL_ENGINE_TOKEN;
  if (!expected) return false;
  return req.headers['x-social-token'] === expected;
}

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
      const when = String(body.when || '').trim();
      if (!when) return sendJson(res, 400, { error: 'Say when you would like to meet' });
      // QA B5: headcount must be a whole number between 1 and 12.
      const people = Number(body.people);
      if (!Number.isInteger(people) || people < 1 || people > 12) {
        return sendJson(res, 400, { error: 'People must be a whole number between 1 and 12' });
      }
      // Two booking sources:
      //  a) an Offer (v2): a regular person's hosted moment. The host is
      //     named on the Offer, not in the seed locals list.
      //  b) a seed local, usually via their Drop (QA B6 still applies).
      let local = null;
      let localName = '';
      let offerId = null;
      if (body.offerId) {
        const offer = await backend.getOffer(body.offerId);
        if (!offer) return sendJson(res, 400, { error: 'Offer not found' });
        offerId = offer.id;
        localName = offer.posterName;
      } else {
        local = store.localById(body.localId);
        if (!local) return sendJson(res, 400, { error: 'Unknown local' });
        // QA B6: a booking made from a Drop must be for that Drop's local.
        if (body.dropId) {
          const drop = store.drops.find((d) => d.id === body.dropId);
          if (!drop || drop.localId !== local.id) {
            return sendJson(res, 400, { error: 'That Drop belongs to a different local' });
          }
        }
      }
      const booking = {
        id: store.genId('booking'),
        userId: user.id,
        localId: local ? local.id : '',
        localName,
        dropId: body.dropId || null,
        offerId,
        when,
        people,
        method: body.method || 'ninjji',
        pickupLocation: String(body.pickupLocation || '').trim(),
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
        return sendJson(res, 400, { error: 'You cannot top up with credits. Choose US dollars or a crypto instead.' });
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

    // ---------- v2: Offers (locals hosting a moment) ----------
    if (action === 'offers' && req.method === 'GET') {
      const [offers, buddies] = await Promise.all([backend.listOffers(), backend.listBuddies()]);
      const out = [];
      for (const o of offers) {
        const view = store.publicOffer(o, await backend.countOfferBookings(o.id),
          engine.matchCount({ marketId: o.marketId, kind: 'offer', buddies }));
        view.mine = !!user && o.userId === user.id;
        out.push(view);
      }
      return sendJson(res, 200, { offers: out, demo: true });
    }

    if (action === 'offers' && req.method === 'POST') {
      const body = await readBody(req);
      const who = posterIdentity(user, body);
      if (!who) return sendJson(res, 400, { error: 'Add your name so people know who is hosting' });
      if (!store.marketById(body.marketId)) return sendJson(res, 400, { error: 'Unknown market' });
      const title = String(body.title || '').trim();
      const detail = String(body.detail || '').trim();
      if (!title) return sendJson(res, 400, { error: 'Give your offer a title' });
      if (!detail) return sendJson(res, 400, { error: 'Add a few words about what you are offering' });
      const spots = wholeInRange(body.spots, 1, 20);
      if (spots === null) return sendJson(res, 400, { error: 'Spots must be a whole number between 1 and 20' });
      const price = wholeInRange(body.priceCredits, 0, 1000);
      if (price === null) return sendJson(res, 400, { error: 'Price must be a whole number of credits between 0 (free) and 1000' });
      const claimToken = user ? null : newClaimToken();
      const offer = {
        id: store.genId('offer'),
        userId: who.userId, guestName: who.guestName, posterName: who.posterName,
        marketId: body.marketId, title, detail,
        whenText: String(body.whenText || '').trim(),
        spots, priceCredits: price, claimToken,
        createdAt: new Date().toISOString(),
      };
      await backend.createOffer(offer);
      const message = user
        ? "Posted. It's linked to your account."
        : 'Posted. To get paid, create your free Raahi Expert account and use your claim code to link this post.';
      return sendJson(res, 201, {
        offer: store.publicOffer(offer, 0, 0),
        claimToken,
        message,
      });
    }

    // ---------- v2: Buddy posts (travelers looking for company) ----------
    if (action === 'buddies' && req.method === 'GET') {
      const [buddies, offers, events] = await Promise.all([backend.listBuddies(), backend.listOffers(), allEvents()]);
      const out = buddies.map((b) => store.publicBuddy(b,
        engine.matchCount({ marketId: b.marketId, kind: 'buddy', offers, events })));
      return sendJson(res, 200, { buddies: out, demo: true });
    }

    if (action === 'buddies' && req.method === 'POST') {
      const body = await readBody(req);
      const who = posterIdentity(user, body);
      if (!who) return sendJson(res, 400, { error: 'Add your name so people know who they would travel with' });
      if (!store.marketById(body.marketId)) return sendJson(res, 400, { error: 'Unknown market' });
      const title = String(body.title || '').trim();
      const detail = String(body.detail || '').trim();
      if (!title) return sendJson(res, 400, { error: 'Give your post a title' });
      if (!detail) return sendJson(res, 400, { error: 'Add a few words about what you would like to do' });
      const party = wholeInRange(body.party, 1, 12);
      if (party === null) return sendJson(res, 400, { error: 'Group size must be a whole number between 1 and 12' });
      const buddy = {
        id: store.genId('buddy'),
        userId: who.userId, guestName: who.guestName, posterName: who.posterName,
        marketId: body.marketId, title, detail,
        whenText: String(body.whenText || '').trim(),
        party, createdAt: new Date().toISOString(), responses: [],
      };
      await backend.createBuddy(buddy);
      const message = user
        ? "Posted. It's linked to your account. Only people with a Raahi profile can respond."
        : 'Posted. When you create a free Raahi account, people can answer you there — only people with a Raahi profile can respond.';
      return sendJson(res, 201, { buddy: store.publicBuddy(buddy, 0), message });
    }

    if (action === 'buddy-respond' && req.method === 'POST') {
      // Safety rule: responses come only from real Raahi profiles, so
      // nobody travels with a total stranger.
      if (!requireUser()) return;
      const body = await readBody(req);
      const buddy = await backend.getBuddy(body.buddyId);
      if (!buddy) return sendJson(res, 404, { error: 'Buddy post not found' });
      const message = String(body.message || '').trim();
      if (!message) return sendJson(res, 400, { error: 'Write a short message first' });
      await backend.addBuddyResponse(buddy.id, {
        userId: user.id, responderName: user.name, message,
        createdAt: new Date().toISOString(),
      });
      const saved = await backend.getBuddy(buddy.id);
      return sendJson(res, 201, { buddy: saved ? store.publicBuddy(saved, 0) : null });
    }

    // ---------- v2: Events (vendors post, Raahi distributes) ----------
    if (action === 'events' && req.method === 'GET') {
      const [events, buddies] = await Promise.all([allEvents(), backend.listBuddies()]);
      const out = events.map((e) => store.publicEvent(e,
        engine.matchCount({ marketId: e.marketId, kind: 'event', buddies })));
      return sendJson(res, 200, { events: out, demo: true });
    }

    if (action === 'events' && req.method === 'POST') {
      const body = await readBody(req);
      // Events carry their own `name`, so the guest poster's name
      // travels as `hostName` here (offers/buddies use `name`, since
      // their content field is `title`).
      const who = posterIdentity(user, { name: body.hostName });
      if (!who) return sendJson(res, 400, { error: 'Add your name so people know who is hosting' });
      if (!store.marketById(body.marketId)) return sendJson(res, 400, { error: 'Unknown market' });
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'Give your event a name' });
      const dateText = String(body.dateText || '').trim();
      if (!dateText) return sendJson(res, 400, { error: 'Say when the event happens' });
      const claimToken = user ? null : newClaimToken();
      const event = {
        id: store.genId('event'),
        userId: who.userId, guestName: who.guestName, posterName: who.posterName,
        marketId: body.marketId, name,
        detail: String(body.detail || '').trim(),
        dateText,
        placeText: String(body.placeText || '').trim(),
        claimToken, example: false,
        createdAt: new Date().toISOString(),
      };
      await backend.createEvent(event);
      const message = user
        ? "Posted. It's linked to your account."
        : 'Posted. To get paid, create your free Raahi Expert account and use your claim code to link this post.';
      return sendJson(res, 201, { event: store.publicEvent(event, 0), claimToken, message });
    }

    // ---------- v2: Share / social distribution outbox ----------
    if (action === 'share' && req.method === 'POST') {
      const body = await readBody(req);
      const kind = String(body.kind || '');
      if (!['drop', 'offer', 'event', 'buddy'].includes(kind)) {
        return sendJson(res, 400, { error: 'Unknown share kind' });
      }
      const item = await resolveShareItem(kind, body.refId);
      if (!item) return sendJson(res, 404, { error: 'That post could not be found' });
      const row = await backend.addOutbox({
        kind, refId: String(body.refId), platform: 'all',
        payload: sharePayload(item.title, item.marketId),
        userId: user ? user.id : null,
      });
      return sendJson(res, 201, {
        queued: true, id: row.id,
        message: "Queued. It will go out when Raahi's social engine is connected.",
      });
    }

    // ---------- Social engine drain (token-gated, see INTEGRATION.md) ----------
    if (action === 'outbox' && req.method === 'GET') {
      if (!socialTokenOk(req)) return sendJson(res, 401, { error: 'Social engine token required' });
      const queued = await backend.listOutbox('queued');
      const enriched = [];
      for (const row of queued) {
        const item = await resolveShareItem(row.kind, row.refId);
        enriched.push({
          ...row,
          item,
          payloads: item ? social.buildPayloads(item) : null,
          accounts: social.ACCOUNTS,
        });
      }
      return sendJson(res, 200, { outbox: enriched, accounts: social.ACCOUNTS, demo: true });
    }

    if (action === 'outbox-update' && req.method === 'POST') {
      if (!socialTokenOk(req)) return sendJson(res, 401, { error: 'Social engine token required' });
      const body = await readBody(req);
      const status = String(body.status || '');
      if (!['posted', 'failed'].includes(status)) {
        return sendJson(res, 400, { error: 'Status must be "posted" or "failed"' });
      }
      const updated = await backend.updateOutbox(String(body.id || ''), {
        status,
        externalUrl: body.externalUrl ? String(body.externalUrl) : null,
        note: body.note ? String(body.note) : null,
      });
      if (!updated) return sendJson(res, 404, { error: 'Outbox row not found' });
      return sendJson(res, 200, { outbox: updated });
    }

    // Public read: which social accounts NOW will post to. Handles are
    // null until Imesh provides the accounts (lib/social.js registry).
    // Internal engine fields (connectorAccountId) are stripped here —
    // this endpoint is public; the token-gated drain above gets the
    // full registry.
    if (action === 'social-accounts' && req.method === 'GET') {
      const publicAccounts = social.ACCOUNTS.map(({ connectorAccountId, ...rest }) => rest);
      return sendJson(res, 200, { accounts: publicAccounts, demo: true });
    }

    // ---------- v2: Appreciation tips ----------
    if (action === 'tip' && req.method === 'POST') {
      if (!requireUser()) return;
      const body = await readBody(req);
      const kind = String(body.kind || '');
      if (!['offer', 'buddy', 'event'].includes(kind)) {
        return sendJson(res, 400, { error: 'Unknown tip target' });
      }
      let target = null;
      let title = '';
      if (kind === 'offer') { target = await backend.getOffer(body.refId); title = target ? target.title : ''; }
      if (kind === 'buddy') { target = await backend.getBuddy(body.refId); title = target ? target.title : ''; }
      if (kind === 'event') { target = (await allEvents()).find((x) => x.id === body.refId) || null; title = target ? target.name : ''; }
      if (!target) return sendJson(res, 404, { error: 'That post could not be found' });
      if (target.userId && target.userId === user.id) {
        return sendJson(res, 400, { error: "You can't tip your own post" });
      }
      const amount = wholeInRange(body.amount, 1, 1000);
      if (amount === null) return sendJson(res, 400, { error: 'Tip must be a whole number of credits between 1 and 1000' });
      const method = String(body.method || 'ninjji');
      if (!store.paymentMethods.some((m) => m.id === method)) {
        return sendJson(res, 400, { error: 'Unknown payment method' });
      }
      const balance = await backend.walletBalance(user.id);
      if (balance < amount) {
        return sendJson(res, 402, { error: 'Not enough credits for that tip. Top up the wallet first.' });
      }
      await backend.addWallet(user.id, -amount);
      const charge = await payments.getProvider().createCharge({
        userId: user.id, kind: 'tip', amountCredits: amount, method,
        detail: `Appreciation for: ${title}`.slice(0, 90),
        walletAddress: user.walletAddress || body.walletAddress || null,
      });
      const tip = await backend.createTip({
        fromUserId: user.id, kind, refId: String(body.refId),
        amountCredits: amount, method, paymentId: charge.id,
      });
      return sendJson(res, 201, { tip, wallet: await walletView(user.id), message: `You sent ${amount} credits as a thank-you.` });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 500, { error: 'Server error', detail: String(err && err.message || err) });
  }
}

module.exports = { handle };
