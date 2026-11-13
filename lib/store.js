// Data layer for Raahi NOW.
//
// Two backends behind ONE async interface — the same code paths run on both:
//
// 1. Neon Postgres (production): when DATABASE_URL is set. Uses the
//    @neondatabase/serverless driver (HTTPS, built for Vercel serverless).
//    Tables are created on first use with idempotent DDL (see ensureNeon).
// 2. Local JSON file (development fallback): when DATABASE_URL is NOT set.
//    State lives in data/dev-db.json (gitignored) so the app runs and can
//    be tested locally end to end with no database provisioned.
//
// Content (markets, locals, Drops, payment methods, config) stays as seed
// data in data/seed.json — it is content, not user state. User state
// (users, sessions, wallets, unlocks, asks, answers, bookings, payments)
// and the persistent Drop unlock counters live in the store backend.
// Nothing outside this file touches raw state.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const seed = require('../data/seed.json');

const USE_NEON = !!process.env.DATABASE_URL;
const DEV_DB_PATH = path.join(__dirname, '..', 'data', 'dev-db.json');

// ---------- Seed-derived content (sync, identical for both backends) ----------

// QA B3: a Drop's expiry window is NOT computed here anymore. It is
// seeded once into the store backend (drop_counters.expires_at in Neon,
// counters[dropId].expiresAt in the file store) as now + expiresInMinutes
// at first seed only, and read back from the store on every load — so a
// cold start / server restart never resets a Drop's window.
const dropsCache = seed.drops.map((d) => ({ ...d }));

function seedExpiry(dropId) {
  const d = seed.drops.find((x) => x.id === dropId);
  const minutes = d ? d.expiresInMinutes || 0 : 0;
  return new Date(Date.now() + minutes * 60000).toISOString();
}

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function localById(id) {
  return seed.locals.find((l) => l.id === id) || null;
}

function marketById(id) {
  return seed.markets.find((m) => m.id === id) || null;
}

function seedUsed(dropId) {
  const d = seed.drops.find((x) => x.id === dropId);
  return d ? d.unlocksUsed || 0 : 0;
}

function seedAsks() {
  const now = new Date().toISOString();
  return (seed.asks || []).map((a) => ({
    id: a.id,
    userId: null,
    marketId: a.marketId,
    text: a.text,
    budget: a.budget || '',
    hours: a.hours || '',
    authorName: a.traveller || 'Traveller',
    createdAt: a.createdAt || now,
    answers: (a.answers || []).map((ans) => ({
      localId: ans.localId,
      text: ans.text,
      createdAt: ans.createdAt || now,
    })),
  }));
}

// Public shape of a Drop. exactPlace / meetDetail are included ONLY when
// the requesting user has unlocked this Drop. expiresAt comes from the
// persisted store state (QA B3), not from process memory.
function publicDrop(drop, unlocksUsed, unlocked, expiresAt) {
  const exp = expiresAt || drop.expiresAt;
  const unlocksLeft = Math.max(0, drop.unlockCap - unlocksUsed);
  const expired = new Date(exp).getTime() <= Date.now();
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
    expiresAt: exp,
    unlockCap: drop.unlockCap,
    unlocksUsed,
    unlocksLeft,
    illustrative: !!drop.illustrative,
    unlocked: !!unlocked,
    closed: expired || unlocksLeft <= 0,
    status: expired ? 'expired' : unlocksLeft <= 0 ? 'full' : 'live',
    exactPlace: unlocked ? drop.exactPlace : null,
    meetDetail: unlocked ? drop.meetDetail : null,
  };
}

// Seeded example events (content in seed.json, like Drops). They merge
// with store-posted events at read time and are marked example: true.
function seedEvents() {
  return (seed.events || []).map((e) => ({
    id: e.id,
    userId: null,
    guestName: null,
    posterName: e.host || 'Local host',
    marketId: e.marketId,
    name: e.name,
    detail: e.detail || '',
    dateText: e.dateText || '',
    placeText: e.placeText || '',
    createdAt: e.createdAt || new Date(0).toISOString(),
    example: true,
  }));
}

// Public shapes for the v2 two-sided posts. claimToken is NEVER part of
// a public shape — it is returned once, only in the POST response, so a
// guest poster can later link the post to a Raahi Expert account.
function publicOffer(offer, spotsTaken, matches) {
  const taken = spotsTaken || 0;
  return {
    id: offer.id,
    posterName: offer.posterName,
    mine: false,
    marketId: offer.marketId,
    market: marketById(offer.marketId),
    title: offer.title,
    detail: offer.detail || '',
    whenText: offer.whenText || '',
    spots: offer.spots,
    spotsTaken: taken,
    spotsLeft: Math.max(0, offer.spots - taken),
    priceCredits: offer.priceCredits,
    free: offer.priceCredits === 0,
    matches: matches || 0,
    createdAt: offer.createdAt,
  };
}

function publicBuddy(buddy, matches) {
  const responses = (buddy.responses || []).map((r) => ({
    name: r.responderName || 'Raahi member',
    firstName: String(r.responderName || 'Raahi member').split(' ')[0],
    message: r.message,
    createdAt: r.createdAt,
  }));
  return {
    id: buddy.id,
    posterName: buddy.posterName,
    marketId: buddy.marketId,
    market: marketById(buddy.marketId),
    title: buddy.title,
    detail: buddy.detail || '',
    whenText: buddy.whenText || '',
    party: buddy.party,
    responseCount: responses.length,
    responses,
    matches: matches || 0,
    createdAt: buddy.createdAt,
  };
}

function publicEvent(event, matches) {
  return {
    id: event.id,
    posterName: event.posterName,
    marketId: event.marketId,
    market: marketById(event.marketId),
    name: event.name,
    detail: event.detail || '',
    dateText: event.dateText || '',
    placeText: event.placeText || '',
    example: !!event.example,
    matches: matches || 0,
    createdAt: event.createdAt,
  };
}

function publicAsk(ask) {
  return {
    id: ask.id,
    marketId: ask.marketId,
    market: marketById(ask.marketId),
    text: ask.text,
    budget: ask.budget || '',
    hours: ask.hours || '',
    traveller: ask.authorName || 'Traveller',
    createdAt: ask.createdAt,
    answers: (ask.answers || []).map((a) => ({ ...a, local: localById(a.localId) })),
  };
}

// ---------- Neon backend ----------

let neonSql = null;
let neonReady = null;

function sql() {
  if (!neonSql) {
    // Required lazily so module load never fails when the driver or the
    // connection string is absent/misconfigured — only queries fail.
    const { neon } = require('@neondatabase/serverless');
    neonSql = neon(process.env.DATABASE_URL);
  }
  return neonSql;
}

function ensureNeon() {
  if (!neonReady) {
    neonReady = (async () => {
      const q = sql();
      await q`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        wallet_address TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT`;
      // Connection readiness: future Firebase UID (or other external
      // identity) maps here. Nullable, unused by auth today.
      await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id TEXT`;
      await q`CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS wallets (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        balance_credits INTEGER NOT NULL
      )`;
      await q`CREATE TABLE IF NOT EXISTS unlocks (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        drop_id TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, drop_id)
      )`;
      await q`CREATE TABLE IF NOT EXISTS asks (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        market_id TEXT NOT NULL,
        text TEXT NOT NULL,
        budget TEXT NOT NULL DEFAULT '',
        hours TEXT NOT NULL DEFAULT '',
        author_name TEXT NOT NULL DEFAULT 'Traveller',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY,
        ask_id TEXT NOT NULL REFERENCES asks(id) ON DELETE CASCADE,
        local_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        local_id TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        amount_credits INTEGER NOT NULL,
        method TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        wallet_address TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`ALTER TABLE payments ADD COLUMN IF NOT EXISTS wallet_address TEXT`;
      await q`CREATE TABLE IF NOT EXISTS drop_counters (
        drop_id TEXT PRIMARY KEY,
        unlocks_used INTEGER NOT NULL,
        expires_at TIMESTAMPTZ
      )`;
      await q`ALTER TABLE drop_counters ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`;
      // Offer bookings live in bookings too; offer_id gets its own
      // column so spot counts don't need to parse the detail JSON.
      await q`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS offer_id TEXT`;
      // ---- v2: two-sided posting, events, tips, social outbox ----
      await q`CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        guest_name TEXT,
        market_id TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        when_text TEXT NOT NULL DEFAULT '',
        spots INTEGER NOT NULL,
        price_credits INTEGER NOT NULL DEFAULT 0,
        claim_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS buddy_posts (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        guest_name TEXT,
        market_id TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        when_text TEXT NOT NULL DEFAULT '',
        party INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS buddy_responses (
        id TEXT PRIMARY KEY,
        buddy_id TEXT NOT NULL REFERENCES buddy_posts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        guest_name TEXT,
        market_id TEXT NOT NULL,
        name TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        date_text TEXT NOT NULL DEFAULT '',
        place_text TEXT NOT NULL DEFAULT '',
        claim_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS tips (
        id TEXT PRIMARY KEY,
        from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        amount_credits INTEGER NOT NULL,
        method TEXT NOT NULL,
        payment_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        platform TEXT,
        payload TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      // Social engine drain results (see lib/social.js / INTEGRATION.md):
      // when the engine posts a queued row it stamps posted_at and the
      // live URL; when a post fails it records why in fail_note.
      await q`ALTER TABLE outbox ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ`;
      await q`ALTER TABLE outbox ADD COLUMN IF NOT EXISTS external_url TEXT`;
      await q`ALTER TABLE outbox ADD COLUMN IF NOT EXISTS fail_note TEXT`;
      // Seed counters + Drop windows + the seed Ask (content rows,
      // idempotent). QA B3: expires_at is written ONCE here (first seed
      // only, ON CONFLICT DO NOTHING) and read back ever after.
      for (const d of seed.drops) {
        await q`INSERT INTO drop_counters (drop_id, unlocks_used, expires_at) VALUES (${d.id}, ${d.unlocksUsed || 0}, ${seedExpiry(d.id)})
                ON CONFLICT (drop_id) DO NOTHING`;
        await q`UPDATE drop_counters SET expires_at = ${seedExpiry(d.id)} WHERE drop_id = ${d.id} AND expires_at IS NULL`;
      }
      for (const a of seedAsks()) {
        await q`INSERT INTO asks (id, user_id, market_id, text, budget, hours, author_name, created_at)
                VALUES (${a.id}, NULL, ${a.marketId}, ${a.text}, ${a.budget}, ${a.hours}, ${a.authorName}, ${a.createdAt})
                ON CONFLICT (id) DO NOTHING`;
        for (const ans of a.answers) {
          await q`INSERT INTO answers (id, ask_id, local_id, text, created_at)
                  VALUES (${genId('ans')}, ${a.id}, ${ans.localId}, ${ans.text}, ${ans.createdAt})
                  ON CONFLICT DO NOTHING`;
        }
      }
    })();
  }
  return neonReady;
}

const neonStore = {
  async createUser({ name, email, passwordHash }) {
    await ensureNeon();
    const q = sql();
    const id = genId('user');
    try {
      await q`INSERT INTO users (id, name, email, password_hash) VALUES (${id}, ${name}, ${email}, ${passwordHash})`;
    } catch (e) {
      if (String(e.message || '').includes('users_email') || String(e.code || '') === '23505') {
        const err = new Error('duplicate email'); err.code = 'DUPLICATE_EMAIL'; throw err;
      }
      throw e;
    }
    await q`INSERT INTO wallets (user_id, balance_credits) VALUES (${id}, ${seed.config.startingCredits})`;
    return { id, name, email };
  },
  async getUserByEmail(email) {
    await ensureNeon();
    const rows = await sql()`SELECT id, name, email, password_hash, wallet_address, external_id FROM users WHERE email = ${email}`;
    return rows[0] ? { id: rows[0].id, name: rows[0].name, email: rows[0].email, passwordHash: rows[0].password_hash, walletAddress: rows[0].wallet_address || null, externalId: rows[0].external_id || null } : null;
  },
  async getUserById(id) {
    await ensureNeon();
    const rows = await sql()`SELECT id, name, email, wallet_address, external_id FROM users WHERE id = ${id}`;
    return rows[0] ? { id: rows[0].id, name: rows[0].name, email: rows[0].email, walletAddress: rows[0].wallet_address || null, externalId: rows[0].external_id || null } : null;
  },
  async setWalletAddress(userId, address) {
    await ensureNeon();
    await sql()`UPDATE users SET wallet_address = ${address} WHERE id = ${userId}`;
  },
  async createSession(userId, tokenHash, expiresAtIso) {
    await ensureNeon();
    await sql()`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${tokenHash}, ${userId}, ${expiresAtIso})`;
  },
  async getUserBySession(tokenHash) {
    await ensureNeon();
    const q = sql();
    const rows = await q`SELECT u.id, u.name, u.email, u.wallet_address, u.external_id, s.expires_at FROM sessions s
                         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${tokenHash}`;
    if (!rows[0]) return null;
    if (new Date(rows[0].expires_at).getTime() <= Date.now()) {
      await q`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
      return null;
    }
    return { id: rows[0].id, name: rows[0].name, email: rows[0].email, walletAddress: rows[0].wallet_address || null, externalId: rows[0].external_id || null };
  },
  async deleteSession(tokenHash) {
    await ensureNeon();
    await sql()`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
  },
  async walletBalance(userId) {
    await ensureNeon();
    const rows = await sql()`SELECT balance_credits FROM wallets WHERE user_id = ${userId}`;
    return rows[0] ? rows[0].balance_credits : 0;
  },
  async addWallet(userId, delta) {
    await ensureNeon();
    const q = sql();
    const rows = await q`UPDATE wallets SET balance_credits = balance_credits + ${delta}
                         WHERE user_id = ${userId} RETURNING balance_credits`;
    return rows[0] ? rows[0].balance_credits : 0;
  },
  async addPayment(p) {
    await ensureNeon();
    await sql()`INSERT INTO payments (id, user_id, kind, amount_credits, method, detail, wallet_address)
                VALUES (${genId('pay')}, ${p.userId}, ${p.kind}, ${p.credits}, ${p.method}, ${p.detail || ''}, ${p.walletAddress || null})`;
  },
  async listPayments(userId) {
    await ensureNeon();
    const rows = await sql()`SELECT id, kind, method, amount_credits, detail, wallet_address, created_at FROM payments
                             WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 100`;
    return rows.map((r) => ({ id: r.id, kind: r.kind, method: r.method, credits: r.amount_credits, detail: r.detail, walletAddress: r.wallet_address || null, demo: true, createdAt: new Date(r.created_at).toISOString() }));
  },
  async unlockedIds(userId) {
    if (!userId) return [];
    await ensureNeon();
    const rows = await sql()`SELECT drop_id FROM unlocks WHERE user_id = ${userId}`;
    return rows.map((r) => r.drop_id);
  },
  async addUnlock(userId, dropId, method) {
    await ensureNeon();
    await sql()`INSERT INTO unlocks (user_id, drop_id, payment_method) VALUES (${userId}, ${dropId}, ${method})
                ON CONFLICT (user_id, drop_id) DO NOTHING`;
  },
  async dropState(dropId) {
    await ensureNeon();
    const q = sql();
    await q`INSERT INTO drop_counters (drop_id, unlocks_used, expires_at) VALUES (${dropId}, ${seedUsed(dropId)}, ${seedExpiry(dropId)})
            ON CONFLICT (drop_id) DO NOTHING`;
    const rows = await q`SELECT unlocks_used, expires_at FROM drop_counters WHERE drop_id = ${dropId}`;
    const r = rows[0];
    return {
      used: r ? r.unlocks_used : seedUsed(dropId),
      expiresAt: r && r.expires_at ? new Date(r.expires_at).toISOString() : seedExpiry(dropId),
    };
  },
  async dropUsed(dropId) {
    return (await this.dropState(dropId)).used;
  },
  async bumpDropUsed(dropId) {
    await ensureNeon();
    const q = sql();
    await q`INSERT INTO drop_counters (drop_id, unlocks_used, expires_at) VALUES (${dropId}, ${seedUsed(dropId) + 1}, ${seedExpiry(dropId)})
            ON CONFLICT (drop_id) DO UPDATE SET unlocks_used = drop_counters.unlocks_used + 1`;
    return this.dropUsed(dropId);
  },
  async getAsk(askId) {
    await ensureNeon();
    const q = sql();
    const rows = await q`SELECT id, user_id, market_id, text, budget, hours, author_name, created_at FROM asks WHERE id = ${askId}`;
    if (!rows[0]) return null;
    const ans = await q`SELECT local_id, text, created_at FROM answers WHERE ask_id = ${askId} ORDER BY created_at ASC`;
    const r = rows[0];
    return {
      id: r.id, userId: r.user_id, marketId: r.market_id, text: r.text, budget: r.budget,
      hours: r.hours, authorName: r.author_name, createdAt: new Date(r.created_at).toISOString(),
      answers: ans.map((a) => ({ localId: a.local_id, text: a.text, createdAt: new Date(a.created_at).toISOString() })),
    };
  },
  async listAsks() {
    await ensureNeon();
    const q = sql();
    const askRows = await q`SELECT id, user_id, market_id, text, budget, hours, author_name, created_at FROM asks ORDER BY created_at DESC`;
    const ansRows = await q`SELECT ask_id, local_id, text, created_at FROM answers ORDER BY created_at ASC`;
    const byAsk = new Map();
    for (const a of ansRows) {
      if (!byAsk.has(a.ask_id)) byAsk.set(a.ask_id, []);
      byAsk.get(a.ask_id).push({ localId: a.local_id, text: a.text, createdAt: new Date(a.created_at).toISOString() });
    }
    return askRows.map((r) => ({
      id: r.id, userId: r.user_id, marketId: r.market_id, text: r.text, budget: r.budget,
      hours: r.hours, authorName: r.author_name, createdAt: new Date(r.created_at).toISOString(),
      answers: byAsk.get(r.id) || [],
    }));
  },
  async createAsk(ask) {
    await ensureNeon();
    await sql()`INSERT INTO asks (id, user_id, market_id, text, budget, hours, author_name, created_at)
                VALUES (${ask.id}, ${ask.userId}, ${ask.marketId}, ${ask.text}, ${ask.budget || ''}, ${ask.hours || ''}, ${ask.authorName}, ${ask.createdAt})`;
    return ask;
  },
  async askExists(askId) {
    await ensureNeon();
    const rows = await sql()`SELECT id FROM asks WHERE id = ${askId}`;
    return rows.length > 0;
  },
  async addAnswer(askId, answer) {
    await ensureNeon();
    await sql()`INSERT INTO answers (id, ask_id, local_id, text, created_at)
                VALUES (${genId('ans')}, ${askId}, ${answer.localId}, ${answer.text}, ${answer.createdAt})`;
  },
  async listBookings(userId) {
    await ensureNeon();
    const rows = await sql()`SELECT id, local_id, offer_id, detail, status, created_at FROM bookings
                             WHERE user_id = ${userId} ORDER BY created_at DESC`;
    return rows.map((r) => ({ id: r.id, userId, localId: r.local_id, offerId: r.offer_id || null, ...safeParse(r.detail), status: r.status, demo: true, createdAt: new Date(r.created_at).toISOString() }));
  },
  async createBooking(b) {
    await ensureNeon();
    const detail = JSON.stringify({
      dropId: b.dropId || null, offerId: b.offerId || null, when: b.when, people: b.people,
      method: b.method, pickupLocation: b.pickupLocation || '', localName: b.localName || '',
    });
    await sql()`INSERT INTO bookings (id, user_id, local_id, offer_id, detail, status, created_at)
                VALUES (${b.id}, ${b.userId}, ${b.localId}, ${b.offerId || null}, ${detail}, ${b.status}, ${b.createdAt})`;
    return b;
  },
  // ---- v2: offers / buddies / events / tips / outbox ----
  async createOffer(o) {
    await ensureNeon();
    await sql()`INSERT INTO offers (id, user_id, guest_name, market_id, title, detail, when_text, spots, price_credits, claim_token, created_at)
                VALUES (${o.id}, ${o.userId}, ${o.guestName}, ${o.marketId}, ${o.title}, ${o.detail || ''}, ${o.whenText || ''}, ${o.spots}, ${o.priceCredits}, ${o.claimToken}, ${o.createdAt})`;
    return o;
  },
  async getOffer(id) {
    await ensureNeon();
    const rows = await sql()`SELECT o.*, u.name AS user_name FROM offers o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ${id}`;
    return rows[0] ? neonOffer(rows[0]) : null;
  },
  async listOffers() {
    await ensureNeon();
    const rows = await sql()`SELECT o.*, u.name AS user_name FROM offers o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC`;
    return rows.map(neonOffer);
  },
  async countOfferBookings(offerId) {
    await ensureNeon();
    const rows = await sql()`SELECT COUNT(*)::int AS n FROM bookings WHERE offer_id = ${offerId}`;
    return rows[0] ? rows[0].n : 0;
  },
  async createBuddy(b) {
    await ensureNeon();
    await sql()`INSERT INTO buddy_posts (id, user_id, guest_name, market_id, title, detail, when_text, party, created_at)
                VALUES (${b.id}, ${b.userId}, ${b.guestName}, ${b.marketId}, ${b.title}, ${b.detail || ''}, ${b.whenText || ''}, ${b.party}, ${b.createdAt})`;
    return b;
  },
  async getBuddy(id) {
    await ensureNeon();
    const q = sql();
    const rows = await q`SELECT b.*, u.name AS user_name FROM buddy_posts b LEFT JOIN users u ON u.id = b.user_id WHERE b.id = ${id}`;
    if (!rows[0]) return null;
    const resp = await q`SELECT r.message, r.created_at, u.name AS responder_name FROM buddy_responses r
                         JOIN users u ON u.id = r.user_id WHERE r.buddy_id = ${id} ORDER BY r.created_at ASC`;
    return neonBuddy(rows[0], resp);
  },
  async listBuddies() {
    await ensureNeon();
    const q = sql();
    const rows = await q`SELECT b.*, u.name AS user_name FROM buddy_posts b LEFT JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC`;
    const resp = await q`SELECT r.buddy_id, r.message, r.created_at, u.name AS responder_name FROM buddy_responses r
                         JOIN users u ON u.id = r.user_id ORDER BY r.created_at ASC`;
    const byBuddy = new Map();
    for (const r of resp) {
      if (!byBuddy.has(r.buddy_id)) byBuddy.set(r.buddy_id, []);
      byBuddy.get(r.buddy_id).push(r);
    }
    return rows.map((row) => neonBuddy(row, byBuddy.get(row.id) || []));
  },
  async addBuddyResponse(buddyId, resp) {
    await ensureNeon();
    await sql()`INSERT INTO buddy_responses (id, buddy_id, user_id, message, created_at)
                VALUES (${genId('bres')}, ${buddyId}, ${resp.userId}, ${resp.message}, ${resp.createdAt})`;
  },
  async createEvent(e) {
    await ensureNeon();
    await sql()`INSERT INTO events (id, user_id, guest_name, market_id, name, detail, date_text, place_text, claim_token, created_at)
                VALUES (${e.id}, ${e.userId}, ${e.guestName}, ${e.marketId}, ${e.name}, ${e.detail || ''}, ${e.dateText || ''}, ${e.placeText || ''}, ${e.claimToken}, ${e.createdAt})`;
    return e;
  },
  async getEvent(id) {
    await ensureNeon();
    const rows = await sql()`SELECT e.*, u.name AS user_name FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ${id}`;
    return rows[0] ? neonEvent(rows[0]) : null;
  },
  async listEvents() {
    await ensureNeon();
    const rows = await sql()`SELECT e.*, u.name AS user_name FROM events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.created_at DESC`;
    return rows.map(neonEvent);
  },
  async createTip(t) {
    await ensureNeon();
    const id = genId('tip');
    await sql()`INSERT INTO tips (id, from_user_id, kind, ref_id, amount_credits, method, payment_id, created_at)
                VALUES (${id}, ${t.fromUserId}, ${t.kind}, ${t.refId}, ${t.amountCredits}, ${t.method}, ${t.paymentId || null}, ${new Date().toISOString()})`;
    return { id, ...t };
  },
  async addOutbox(row) {
    await ensureNeon();
    const id = genId('out');
    await sql()`INSERT INTO outbox (id, kind, ref_id, platform, payload, status, user_id, created_at)
                VALUES (${id}, ${row.kind}, ${row.refId}, ${row.platform || null}, ${row.payload || ''}, ${'queued'}, ${row.userId || null}, ${new Date().toISOString()})`;
    return { id, ...row, status: 'queued', postedAt: null, externalUrl: null, failNote: null };
  },
  // listOutbox() → every row, newest first. listOutbox('queued') → only
  // rows with that status, OLDEST first — the order the social engine
  // drains the queue in.
  async listOutbox(status) {
    await ensureNeon();
    const q = sql();
    const rows = status
      ? await q`SELECT * FROM outbox WHERE status = ${status} ORDER BY created_at ASC`
      : await q`SELECT * FROM outbox ORDER BY created_at DESC`;
    return rows.map(neonOutbox);
  },
  // patch: { status, externalUrl?, note? } — note lands in fail_note.
  // A 'posted' patch stamps posted_at. Returns the updated row, or
  // null when the id doesn't exist.
  async updateOutbox(id, patch) {
    await ensureNeon();
    const q = sql();
    const postedAt = patch.status === 'posted' ? new Date().toISOString() : null;
    const rows = await q`UPDATE outbox SET
                           status = ${patch.status},
                           posted_at = COALESCE(${postedAt}::timestamptz, posted_at),
                           external_url = COALESCE(${patch.externalUrl || null}, external_url),
                           fail_note = COALESCE(${patch.note || null}, fail_note)
                         WHERE id = ${id} RETURNING *`;
    return rows[0] ? neonOutbox(rows[0]) : null;
  },
};

function neonOffer(r) {
  return {
    id: r.id, userId: r.user_id, guestName: r.guest_name,
    posterName: r.guest_name || r.user_name || 'Raahi member',
    marketId: r.market_id, title: r.title, detail: r.detail, whenText: r.when_text,
    spots: r.spots, priceCredits: r.price_credits, claimToken: r.claim_token,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function neonBuddy(r, respRows) {
  return {
    id: r.id, userId: r.user_id, guestName: r.guest_name,
    posterName: r.guest_name || r.user_name || 'Raahi member',
    marketId: r.market_id, title: r.title, detail: r.detail, whenText: r.when_text,
    party: r.party, createdAt: new Date(r.created_at).toISOString(),
    responses: (respRows || []).map((x) => ({ responderName: x.responder_name, message: x.message, createdAt: new Date(x.created_at).toISOString() })),
  };
}

function neonOutbox(r) {
  return {
    id: r.id, kind: r.kind, refId: r.ref_id, platform: r.platform, payload: r.payload,
    status: r.status, userId: r.user_id, createdAt: new Date(r.created_at).toISOString(),
    postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null,
    externalUrl: r.external_url || null, failNote: r.fail_note || null,
  };
}

function neonEvent(r) {
  return {
    id: r.id, userId: r.user_id, guestName: r.guest_name,
    posterName: r.guest_name || r.user_name || 'Local host',
    marketId: r.market_id, name: r.name, detail: r.detail, dateText: r.date_text,
    placeText: r.place_text, claimToken: r.claim_token, example: false,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

// ---------- Local JSON file backend (fallback) ----------

let fileDb = null;

function loadFileDb() {
  if (fileDb) return fileDb;
  try {
    fileDb = JSON.parse(fs.readFileSync(DEV_DB_PATH, 'utf8'));
  } catch {
    fileDb = {
      users: [], sessions: [], wallets: {}, unlocks: [],
      asks: seedAsks(), bookings: [], payments: [],
      // v2 collections: two-sided posts, events, tips, social outbox.
      offers: [], buddies: [], events: [], tips: [], outbox: [],
      // QA B3: counters carry the persisted Drop window alongside the
      // unlock count: { used, expiresAt } — seeded once, never recomputed.
      counters: Object.fromEntries(seed.drops.map((d) => [d.id, { used: d.unlocksUsed || 0, expiresAt: seedExpiry(d.id) }])),
    };
    saveFileDb();
  }
  // Normalize older dev DBs that predate the v2 collections.
  for (const key of ['offers', 'buddies', 'events', 'tips', 'outbox']) {
    if (!Array.isArray(fileDb[key])) fileDb[key] = [];
  }
  return fileDb;
}

// Normalize a counter entry (older dev DBs stored a bare number).
function fileCounter(db, dropId) {
  let c = db.counters[dropId];
  if (c == null) {
    c = { used: seedUsed(dropId), expiresAt: seedExpiry(dropId) };
    db.counters[dropId] = c;
    saveFileDb();
  } else if (typeof c === 'number') {
    c = { used: c, expiresAt: seedExpiry(dropId) };
    db.counters[dropId] = c;
    saveFileDb();
  }
  return c;
}

function saveFileDb() {
  const tmp = `${DEV_DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(fileDb, null, 2));
  fs.renameSync(tmp, DEV_DB_PATH);
}

const fileStore = {
  async createUser({ name, email, passwordHash }) {
    const db = loadFileDb();
    if (db.users.some((u) => u.email === email)) {
      const err = new Error('duplicate email'); err.code = 'DUPLICATE_EMAIL'; throw err;
    }
    const user = { id: genId('user'), name, email, passwordHash, createdAt: new Date().toISOString() };
    db.users.push(user);
    db.wallets[user.id] = seed.config.startingCredits;
    saveFileDb();
    return { id: user.id, name, email };
  },
  async getUserByEmail(email) {
    const u = loadFileDb().users.find((x) => x.email === email);
    return u ? { id: u.id, name: u.name, email: u.email, passwordHash: u.passwordHash, walletAddress: u.walletAddress || null, externalId: u.externalId || null } : null;
  },
  async getUserById(id) {
    const u = loadFileDb().users.find((x) => x.id === id);
    return u ? { id: u.id, name: u.name, email: u.email, walletAddress: u.walletAddress || null, externalId: u.externalId || null } : null;
  },
  async setWalletAddress(userId, address) {
    const db = loadFileDb();
    const u = db.users.find((x) => x.id === userId);
    if (u) { u.walletAddress = address; saveFileDb(); }
  },
  async createSession(userId, tokenHash, expiresAtIso) {
    const db = loadFileDb();
    db.sessions.push({ tokenHash, userId, expiresAt: expiresAtIso });
    saveFileDb();
  },
  async getUserBySession(tokenHash) {
    const db = loadFileDb();
    const s = db.sessions.find((x) => x.tokenHash === tokenHash);
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() <= Date.now()) {
      db.sessions = db.sessions.filter((x) => x.tokenHash !== tokenHash);
      saveFileDb();
      return null;
    }
    const u = db.users.find((x) => x.id === s.userId);
    return u ? { id: u.id, name: u.name, email: u.email, walletAddress: u.walletAddress || null, externalId: u.externalId || null } : null;
  },
  async deleteSession(tokenHash) {
    const db = loadFileDb();
    db.sessions = db.sessions.filter((x) => x.tokenHash !== tokenHash);
    saveFileDb();
  },
  async walletBalance(userId) {
    return loadFileDb().wallets[userId] || 0;
  },
  async addWallet(userId, delta) {
    const db = loadFileDb();
    db.wallets[userId] = (db.wallets[userId] || 0) + delta;
    saveFileDb();
    return db.wallets[userId];
  },
  async addPayment(p) {
    const db = loadFileDb();
    db.payments.unshift({ id: genId('pay'), userId: p.userId, kind: p.kind, method: p.method, credits: p.credits, detail: p.detail || '', walletAddress: p.walletAddress || null, demo: true, createdAt: new Date().toISOString() });
    saveFileDb();
  },
  async listPayments(userId) {
    return loadFileDb().payments.filter((p) => p.userId === userId);
  },
  async unlockedIds(userId) {
    if (!userId) return [];
    return loadFileDb().unlocks.filter((u) => u.userId === userId).map((u) => u.dropId);
  },
  async addUnlock(userId, dropId, method) {
    const db = loadFileDb();
    if (!db.unlocks.some((u) => u.userId === userId && u.dropId === dropId)) {
      db.unlocks.push({ userId, dropId, method, createdAt: new Date().toISOString() });
      saveFileDb();
    }
  },
  async dropState(dropId) {
    const c = fileCounter(loadFileDb(), dropId);
    return { used: c.used, expiresAt: c.expiresAt };
  },
  async dropUsed(dropId) {
    return (await this.dropState(dropId)).used;
  },
  async bumpDropUsed(dropId) {
    const db = loadFileDb();
    const c = fileCounter(db, dropId);
    c.used += 1;
    saveFileDb();
    return c.used;
  },
  async getAsk(askId) {
    return loadFileDb().asks.find((a) => a.id === askId) || null;
  },
  async listAsks() {
    return [...loadFileDb().asks].reverse();
  },
  async createAsk(ask) {
    const db = loadFileDb();
    db.asks.push({ ...ask, answers: [] });
    saveFileDb();
    return ask;
  },
  async askExists(askId) {
    return loadFileDb().asks.some((a) => a.id === askId);
  },
  async addAnswer(askId, answer) {
    const db = loadFileDb();
    const ask = db.asks.find((a) => a.id === askId);
    if (!ask) return;
    ask.answers = ask.answers || [];
    ask.answers.push(answer);
    saveFileDb();
  },
  async listBookings(userId) {
    return loadFileDb().bookings.filter((b) => b.userId === userId);
  },
  async createBooking(b) {
    const db = loadFileDb();
    db.bookings.unshift(b);
    saveFileDb();
    return b;
  },
  // ---- v2: offers / buddies / events / tips / outbox ----
  async createOffer(o) {
    const db = loadFileDb();
    db.offers.unshift(o);
    saveFileDb();
    return o;
  },
  async getOffer(id) {
    return loadFileDb().offers.find((o) => o.id === id) || null;
  },
  async listOffers() {
    return [...loadFileDb().offers];
  },
  async countOfferBookings(offerId) {
    return loadFileDb().bookings.filter((b) => b.offerId === offerId).length;
  },
  async createBuddy(b) {
    const db = loadFileDb();
    db.buddies.unshift({ ...b, responses: [] });
    saveFileDb();
    return b;
  },
  async getBuddy(id) {
    return loadFileDb().buddies.find((b) => b.id === id) || null;
  },
  async listBuddies() {
    return [...loadFileDb().buddies];
  },
  async addBuddyResponse(buddyId, resp) {
    const db = loadFileDb();
    const buddy = db.buddies.find((b) => b.id === buddyId);
    if (!buddy) return;
    buddy.responses = buddy.responses || [];
    buddy.responses.push(resp);
    saveFileDb();
  },
  async createEvent(e) {
    const db = loadFileDb();
    db.events.unshift(e);
    saveFileDb();
    return e;
  },
  async getEvent(id) {
    return loadFileDb().events.find((e) => e.id === id) || null;
  },
  async listEvents() {
    return [...loadFileDb().events];
  },
  async createTip(t) {
    const db = loadFileDb();
    const tip = { id: genId('tip'), createdAt: new Date().toISOString(), ...t };
    db.tips.unshift(tip);
    saveFileDb();
    return tip;
  },
  async addOutbox(row) {
    const db = loadFileDb();
    const entry = {
      id: genId('out'), status: 'queued', createdAt: new Date().toISOString(),
      postedAt: null, externalUrl: null, failNote: null, ...row,
    };
    db.outbox.unshift(entry);
    saveFileDb();
    return entry;
  },
  // Same contract as the Neon backend: no status → all rows, newest
  // first; with a status → matching rows only, oldest first.
  async listOutbox(status) {
    const rows = loadFileDb().outbox.map((r) => ({ postedAt: null, externalUrl: null, failNote: null, ...r }));
    if (!status) return rows;
    return rows.filter((r) => r.status === status).reverse();
  },
  async updateOutbox(id, patch) {
    const db = loadFileDb();
    const entry = db.outbox.find((o) => o.id === id);
    if (!entry) return null;
    entry.status = patch.status;
    if (patch.status === 'posted') entry.postedAt = new Date().toISOString();
    if (patch.externalUrl) entry.externalUrl = patch.externalUrl;
    if (patch.note) entry.failNote = patch.note;
    saveFileDb();
    return { postedAt: null, externalUrl: null, failNote: null, ...entry };
  },
};

const backend = USE_NEON ? neonStore : fileStore;

module.exports = {
  backend,
  usingNeon: USE_NEON,
  genId,
  config: seed.config,
  markets: seed.markets,
  locals: seed.locals,
  paymentMethods: seed.paymentMethods,
  drops: dropsCache,
  localById,
  marketById,
  publicDrop,
  publicAsk,
  publicOffer,
  publicBuddy,
  publicEvent,
  seedEvents,
};
