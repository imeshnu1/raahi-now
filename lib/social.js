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
// Instagram is connected (@i.travel.with.raahi). The other platforms
// stay handle-null / "awaiting accounts from Imesh" until Imesh hands
// over those accounts. Nothing else needs to change when they land.

const store = require('./store');

const SIGNOFF = 'Real locals. Real places. — Raahi NOW · now.raahi.io';

// Account registry — one entry per platform NOW distributes to.
// Fill `handle` (and flip `status` to 'connected') when Imesh provides
// each account. `connectorAccountId` is an internal posting-engine id
// (never shown to users).
const ACCOUNTS = [
  { platform: 'instagram', handle: 'i.travel.with.raahi', status: 'connected', connectorAccountId: '17841430973767174', formats: ['feed', 'reel'] },
  { platform: 'tiktok', handle: null, status: 'awaiting accounts from Imesh', formats: ['video'] },
  { platform: 'youtube', handle: null, status: 'awaiting accounts from Imesh', formats: ['short'] },
  { platform: 'reddit', handle: null, status: 'awaiting accounts from Imesh', formats: ['post'] },
  { platform: 'facebook', handle: null, status: 'awaiting accounts from Imesh', formats: ['post'] },
];

// ---------- Poster handles ----------

// Handles are stored WITHOUT the leading '@'. A "simple handle
// pattern" per platform: the characters each platform actually allows
// in a username, with sane length bounds. normalizeHandle returns
// { ok: true, handle } where handle is the cleaned handle or null
// (input absent/blank = "no handle given"), or { ok: false } when the
// person typed something that can never be a handle on that platform.
const HANDLE_PATTERNS = {
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  tiktok: /^[A-Za-z0-9._]{2,24}$/,
  youtube: /^[A-Za-z0-9._-]{3,30}$/,
};

function normalizeHandle(raw, platform) {
  if (raw == null) return { ok: true, handle: null };
  let h = String(raw).trim();
  if (!h) return { ok: true, handle: null };
  if (h.startsWith('@')) h = h.slice(1).trim();
  if (!h) return { ok: true, handle: null };
  const re = HANDLE_PATTERNS[platform] || HANDLE_PATTERNS.instagram;
  if (!re.test(h)) return { ok: false, handle: null };
  return { ok: true, handle: h };
}

// Instagram captions are capped at 2,200 characters (connector doc).
// Build the caption, then trim the tail if a long post pushed it over.
function capCaption(s) {
  return s.length > 2200 ? `${s.slice(0, 2197)}…` : s;
}

// Build the ready-to-post text for every platform from one queued
// item. `item` is the normalized shape the API layer resolves from an
// outbox row (or a share request):
//   { kind, title, detail, whenText, marketId }   (events: title = name)
// `marketCity` / `marketCountry` may be supplied directly; otherwise
// the market is looked up from the seed markets by marketId.
// `posterName` / `instagram` carry the DISTRIBUTION attribution (see
// INTEGRATION.md, "Distribution strategy"): when the poster gave an
// Instagram handle, the Instagram caption tags them ("Posted by
// @handle on Raahi NOW") and the payload carries `tagHandle` so the
// posting engine can also add a photo tag. Other platforms get the
// plain display-name attribution — an @handle is only used on the
// platform it belongs to.
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
  const name = String(it.posterName || '').trim();
  // Defensive: handles are normalized at write time, but never let a
  // stray '@' or an impossible handle reach a caption.
  const rawHandle = it.instagram ? String(it.instagram).replace(/^@+/, '').trim() : '';
  const tagHandle = rawHandle && HANDLE_PATTERNS.instagram.test(rawHandle) ? rawHandle : null;
  const igAttribution = tagHandle
    ? `Posted by @${tagHandle} on Raahi NOW`
    : (name ? `Posted by ${name} on Raahi NOW` : '');
  const nameAttribution = name ? `Posted by ${name} on Raahi NOW` : '';
  const redditIntro = name
    ? `Posted by ${name} on Raahi NOW, where locals post things like this themselves.`
    : 'Sharing this from Raahi NOW, where locals post things like this themselves.';
  // Instagram caption: if a long detail would push past 2,200 chars,
  // the DETAIL absorbs the trim — the attribution and sign-off always
  // survive (capCaption stays as a final safety net).
  const igTail = `\n\n${SIGNOFF}\n#RaahiNOW #LocalTravel`;
  const igMeta = `\n${whenBit}${where}${igAttribution ? `\n${igAttribution}` : ''}`;
  let igDetail = detail;
  const igOver = (`${title}\n${igDetail}${igMeta}${igTail}`).length - 2200;
  if (igOver > 0) igDetail = `${igDetail.slice(0, Math.max(0, igDetail.length - igOver - 1))}…`;
  return {
    instagram: capCaption(`${title}\n${igDetail}${igMeta}${igTail}`),
    tiktok: `${title} — ${where}${nameAttribution ? ` · ${nameAttribution}` : ''} · ${SIGNOFF}`,
    youtube: `${title} — ${where}${nameAttribution ? ` · ${nameAttribution}` : ''} · ${SIGNOFF}`,
    reddit: {
      title: `${title} (${where})`,
      body: `${detail}\n\n${when ? `When: ${when}\n\n` : ''}${redditIntro} ${SIGNOFF}`,
    },
    facebook: `${title}\n${detail}\n${whenBit}${where}${nameAttribution ? `\n${nameAttribution}` : ''}\n\n${SIGNOFF}`,
    tagHandle,
  };
}

module.exports = { ACCOUNTS, buildPayloads, SIGNOFF, normalizeHandle, HANDLE_PATTERNS };
