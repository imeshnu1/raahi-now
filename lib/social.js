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
// stay handle-null with an honest awaiting status until their Raahi
// accounts and posting routes exist. In particular, the available
// Threads connector is linked only to Imesh's personal account, so it
// must never be treated as a connected Raahi Threads account.

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
  { platform: 'x', handle: null, status: 'awaiting account and connector', formats: ['post'] },
  { platform: 'threads', handle: null, status: 'awaiting Raahi account', formats: ['post'] },
  { platform: 'reddit', handle: null, status: 'awaiting account and connector', formats: ['post'] },
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
  x: /^[A-Za-z0-9_]{1,15}$/,
  threads: /^[A-Za-z0-9._]{1,30}$/,
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

function validHandle(raw, platform) {
  const h = raw ? String(raw).replace(/^@+/, '').trim() : '';
  return h && HANDLE_PATTERNS[platform].test(h) ? h : null;
}

function trimText(text, max) {
  const s = String(text || '');
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max === 1) return '…';
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

// Build an attribution whose subject fits the short-post budget. For
// ordinary names/handles this is exactly "Posted by <subject> on Raahi
// NOW"; an exceptionally long display name is trimmed so the hard cap
// and the rest of the attribution still survive.
function shortAttribution(platform, handle, name, limit) {
  if (!handle && !name) return '';
  const fixed = 'Posted by '.length + ' on Raahi NOW'.length;
  const maxSubject = Math.max(0, limit - SIGNOFF.length - 3 - fixed);
  const subject = handle ? `@${handle}` : trimText(name, maxSubject);
  return subject ? `Posted by ${subject} on Raahi NOW` : '';
}

// Compose a hard-capped short post. The detail is trimmed first; if
// the title (plus location) still cannot fit with attribution and the
// sign-off, the title is trimmed as well. Attribution + sign-off are
// appended last and are never the part that gets cut.
function composeShortPost(limit, { title, where, detail, attribution }) {
  const suffix = [attribution, SIGNOFF].filter(Boolean).join('\n');
  const suffixBlock = suffix ? `\n\n${suffix}` : '';

  let titleText = String(title || '').trim();
  let wherePart = where ? ` — ${where}` : '';
  let header = `${titleText}${wherePart}`;
  if (header.length + suffixBlock.length > limit) {
    const maxTitle = limit - suffixBlock.length - wherePart.length;
    if (maxTitle >= 1) {
      titleText = trimText(titleText, maxTitle);
    } else {
      wherePart = '';
      titleText = trimText(titleText, limit - suffixBlock.length);
    }
    header = `${titleText}${wherePart}`;
  }

  const detailText = String(detail || '').trim().replace(/\s+/g, ' ');
  const detailRoom = limit - header.length - suffixBlock.length - 2;
  const detailBlock = detailText && detailRoom >= 12
    ? `\n\n${trimText(detailText, detailRoom)}`
    : '';
  return `${header}${detailBlock}${suffixBlock}`;
}

// Build the ready-to-post text for every platform from one queued
// item. `item` is the normalized shape the API layer resolves from an
// outbox row (or a share request):
//   { kind, title, detail, whenText, marketId }   (events: title = name)
// `marketCity` / `marketCountry` may be supplied directly; otherwise
// the market is looked up from the seed markets by marketId.
// `posterName` plus the post's per-platform handles (`instagram`,
// `x`, `threads` — either as top-level fields or in `socials`) carry
// the DISTRIBUTION attribution (see INTEGRATION.md, "Distribution
// strategy"): each platform tags the poster only with that platform's
// own handle ("Posted by @handle on Raahi NOW"). The Instagram
// payload also carries legacy `tagHandle`, and every payload carries
// `tagHandles`, so the posting engine can tag where its platform
// supports it. Platforms without their own collected handle get the
// plain display-name attribution.
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
  // stray '@' or an impossible handle reach a caption. Handles may be
  // supplied in the post's `socials` object or as top-level fields
  // (seed Drops use top-level fields).
  const socials = it.socials && typeof it.socials === 'object' ? it.socials : {};
  const handleFor = (platform) => validHandle(
    socials[platform] != null ? socials[platform] : it[platform],
    platform,
  );
  const tagHandles = {
    instagram: handleFor('instagram'),
    x: handleFor('x'),
    threads: handleFor('threads'),
  };
  const tagHandle = tagHandles.instagram;
  const attributionFor = (platform) => {
    const handle = tagHandles[platform];
    return handle
      ? `Posted by @${handle} on Raahi NOW`
      : (name ? `Posted by ${name} on Raahi NOW` : '');
  };
  const igAttribution = attributionFor('instagram');
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
    x: composeShortPost(280, {
      title,
      where,
      detail,
      attribution: shortAttribution('x', tagHandles.x, name, 280),
    }),
    threads: composeShortPost(500, {
      title,
      where,
      detail,
      attribution: shortAttribution('threads', tagHandles.threads, name, 500),
    }),
    reddit: {
      title: `${title} (${where})`,
      body: `${detail}\n\n${when ? `When: ${when}\n\n` : ''}${redditIntro} ${SIGNOFF}`,
    },
    facebook: `${title}\n${detail}\n${whenBit}${where}${nameAttribution ? `\n${nameAttribution}` : ''}\n\n${SIGNOFF}`,
    tagHandle,
    tagHandles,
  };
}

module.exports = { ACCOUNTS, buildPayloads, SIGNOFF, normalizeHandle, HANDLE_PATTERNS };
