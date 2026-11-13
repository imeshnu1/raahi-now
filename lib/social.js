// Social engine connection for Raahi NOW.
//
// NOW never posts to social media itself. "Queue for auto-posting"
// (POST /api/share) writes rows to the outbox table; Raahi's
// social-pilot engine (running on the Mac mini) drains that queue via
// GET /api/outbox and reports results back via POST /api/outbox-update
// (both gated by the SOCIAL_ENGINE_TOKEN — see INTEGRATION.md,
// "Social engine connection").
//
// This file is the single place that knows:
//   1. WHICH social accounts Raahi NOW posts to (the registry below),
//   2. HOW a queued item reads on each platform (buildPayloads).
//
// Fill the handles in when Imesh provides the accounts — until then
// every handle is null and every account reports
// "awaiting accounts from Imesh". Nothing else needs to change.

const store = require('./store');

const SIGNOFF = 'Real locals. Real places. — Raahi NOW · now.raahi.io';

// Account registry — one entry per platform NOW distributes to.
// Fill `handle` (and flip `status` to 'connected') when Imesh provides
// the accounts.
const ACCOUNTS = [
  { platform: 'instagram', handle: null, status: 'awaiting accounts from Imesh', formats: ['feed', 'reel'] },
  { platform: 'tiktok', handle: null, status: 'awaiting accounts from Imesh', formats: ['video'] },
  { platform: 'youtube', handle: null, status: 'awaiting accounts from Imesh', formats: ['short'] },
  { platform: 'reddit', handle: null, status: 'awaiting accounts from Imesh', formats: ['post'] },
  { platform: 'facebook', handle: null, status: 'awaiting accounts from Imesh', formats: ['post'] },
];

// Build the ready-to-post text for every platform from one queued
// item. `item` is the normalized shape the API layer resolves from an
// outbox row (or a share request):
//   { kind, title, detail, whenText, marketId }   (events: title = name)
// `marketCity` / `marketCountry` may be supplied directly; otherwise
// the market is looked up from the seed markets by marketId.
// Mirrors the client-side share copy in public/main.js (shareCopies),
// with the same sign-off, so what a person copies by hand and what the
// engine posts automatically read the same.
function buildPayloads(item) {
  const it = item || {};
  const title = it.title || it.name || '';
  const detail = it.detail || '';
  const when = it.whenText || it.dateText || '';
  let city = it.marketCity || '';
  let country = it.marketCountry || '';
  if (!city && it.marketId) {
    const m = store.marketById(it.marketId);
    if (m) { city = m.city; country = m.country; }
  }
  const where = city ? (country ? `${city}, ${country}` : city) : '';
  const whenBit = when ? `${when} · ` : '';
  return {
    instagram: `${title}\n${detail}\n${whenBit}${where}\n\n${SIGNOFF}\n#RaahiNOW #LocalTravel`,
    tiktok: `${title} — ${where} · ${SIGNOFF}`,
    youtube: `${title} — ${where} · ${SIGNOFF}`,
    reddit: {
      title: `${title} (${where})`,
      body: `${detail}\n\n${when ? `When: ${when}\n\n` : ''}Sharing this from Raahi NOW, where locals post things like this themselves. ${SIGNOFF}`,
    },
    facebook: `${title}\n${detail}\n${whenBit}${where}\n\n${SIGNOFF}`,
  };
}

module.exports = { ACCOUNTS, buildPayloads, SIGNOFF };
