#!/usr/bin/env node
// Raahi NOW — social poster worker (v1: Instagram only).
//
// Drains the NOW outbox queue and posts each queued item to Instagram
// via the instagram-cli connector binary, then reports the result back
// to the app. This is the v1 stand-in for the Mac-mini social-pilot
// drain described in INTEGRATION.md ("Social engine connection") — it
// speaks exactly the same API:
//
//   GET  {NOW_BASE_URL}/api/outbox         (header x-social-token)
//   POST {NOW_BASE_URL}/api/outbox-update  { id, status, externalUrl?, note? }
//
// Config (process env wins; .env.local in the repo root fills gaps):
//   SOCIAL_ENGINE_TOKEN  shared secret for the drain endpoints. Must
//                        match the value set in the Vercel project.
//                        Until it is set there, the live drain returns
//                        401 for everyone and this worker exits with a
//                        clear message (by design — closed by default).
//   NOW_BASE_URL         default http://localhost:3000
//
// Queue semantics (v1):
//   - One platform per row. Rows queued with platform 'all' (the Share
//     kit) or 'instagram' are posted to Instagram. Rows for any other
//     platform are left queued, untouched.
//   - Instagram is image-first: the item snapshot must carry an image
//     URL (Drops do). A row without one is marked failed with the note
//     "no image available for Instagram yet" — media is never invented.
//   - The downloaded image lands in ~/workspace/social-queue/ (the
//     instagram-cli requires post media to live under ~/workspace).
//
// Flags:
//   --dry-run   fetch + print the planned actions only. Never calls
//               the CLI, never downloads, never updates the outbox.
//   --limit N   max Instagram-eligible rows to process (default 5).
//
// Node built-ins only (fetch + child_process). No dependencies.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTAGRAM_CLI = '/opt/hatch/bin/instagram-cli';
const QUEUE_DIR = path.join(homedir(), 'workspace', 'social-queue');
const CAPTION_MAX = 2200; // Instagram caption limit (connector doc)

// Instagram account for @i.travel.with.raahi — mirrors
// lib/social.js ACCOUNTS (connectorAccountId). Internal id only;
// never printed in captions or other user-facing text.
const INSTAGRAM_ACCOUNT_ID = '17841430973767174';

const TOKEN_401_MESSAGE =
  'SOCIAL_ENGINE_TOKEN is missing or does not match the server (HTTP 401). ' +
  'The outbox drain stays closed until SOCIAL_ENGINE_TOKEN is set in the Vercel ' +
  'project (Production) and the same value is provided to this poster. Nothing was posted.';

// ---------- env ----------
function loadDotEnvLocal() {
  const file = path.join(REPO_ROOT, '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // real env wins
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

// ---------- args ----------
function parseArgs(argv) {
  const args = { dryRun: false, limit: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) { console.error('--limit needs a positive whole number'); process.exit(2); }
      args.limit = n;
    } else if (argv[i].startsWith('--limit=')) {
      const n = Number(argv[i].slice('--limit='.length));
      if (!Number.isInteger(n) || n < 1) { console.error('--limit needs a positive whole number'); process.exit(2); }
      args.limit = n;
    } else {
      console.error(`Unknown flag: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

// ---------- API ----------
async function fetchOutbox(base, token) {
  const res = await fetch(`${base}/api/outbox`, { headers: { 'x-social-token': token } });
  if (res.status === 401) { console.error(TOKEN_401_MESSAGE); process.exit(1); }
  if (!res.ok) { console.error(`GET /api/outbox failed: HTTP ${res.status}`); process.exit(1); }
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.outbox) ? data.outbox : [];
}

async function updateOutbox(base, token, id, patch) {
  const res = await fetch(`${base}/api/outbox-update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-social-token': token },
    body: JSON.stringify({ id, ...patch }),
  });
  if (!res.ok) console.error(`  warning: outbox-update for ${id} → HTTP ${res.status}`);
  return res.ok;
}

// ---------- Instagram ----------
async function downloadImage(url, outboxId) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('image download was empty');
  mkdirSync(QUEUE_DIR, { recursive: true });
  const file = path.join(QUEUE_DIR, `${outboxId}.jpg`);
  writeFileSync(file, buf);
  return file;
}

// Pull a post URL out of the CLI's output: JSON first (common key
// spellings, shallow), then a plain instagram.com URL in the text.
function extractPostUrl(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const queue = [parsed];
    while (queue.length) {
      const cur = queue.shift();
      if (!cur || typeof cur !== 'object') continue;
      for (const [k, v] of Object.entries(cur)) {
        if (typeof v === 'string' && /instagram\.com\//.test(v)) return v;
        if (v && typeof v === 'object') queue.push(v);
        void k;
      }
    }
  } catch { /* not JSON — fall through to the text scan */ }
  const m = String(stdout).match(/https?:\/\/[^\s"']*instagram\.com\/[^\s"']+/);
  return m ? m[0] : null;
}

function postToInstagram(file, caption) {
  const r = spawnSync(INSTAGRAM_CLI, [
    'post-feed',
    '--account-id', INSTAGRAM_ACCOUNT_ID,
    '--file', file,
    '--caption', caption,
    '--retries', '0',
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.error) throw new Error(`instagram-cli could not run: ${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 200);
    throw new Error(`instagram-cli exited ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return extractPostUrl(r.stdout || '');
}

// ---------- main ----------
async function main() {
  loadDotEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  const base = (process.env.NOW_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const token = process.env.SOCIAL_ENGINE_TOKEN || '';

  if (!token) { console.error(TOKEN_401_MESSAGE); process.exit(1); }

  console.log(`Raahi NOW social poster (v1: Instagram) — base ${base}${args.dryRun ? ' — DRY RUN' : ''}`);
  const rows = await fetchOutbox(base, token);
  console.log(`${rows.length} queued row(s) in the outbox.`);

  let planned = 0, posted = 0, failed = 0, leftQueued = 0;
  for (const row of rows) {
    const platform = String(row.platform || 'all').toLowerCase();
    if (platform !== 'all' && platform !== 'instagram') {
      console.log(`- ${row.id} [${row.kind || '?'}] platform "${platform}" — not supported in v1, left queued.`);
      leftQueued++;
      continue;
    }
    if (planned >= args.limit) {
      console.log(`- ${row.id} [${row.kind || '?'}] over --limit ${args.limit}, left queued.`);
      leftQueued++;
      continue;
    }
    planned++;

    const caption = String((row.payloads && row.payloads.instagram) || row.payload || '').slice(0, CAPTION_MAX);
    const imageUrl = (row.item && row.item.image) || row.image || null;
    const title = (row.item && row.item.title) || row.kind || 'post';

    if (args.dryRun) {
      console.log(`- [dry-run] ${row.id} [${row.kind || '?'}] "${title}"`);
      console.log(`    plan: ${imageUrl ? `download ${imageUrl} → ${path.join(QUEUE_DIR, `${row.id}.jpg`)}` : 'NO IMAGE — would mark failed ("no image available for Instagram yet")'}`);
      console.log(`    plan: instagram-cli post-feed --account-id <instagram> --file <image> --caption "${caption.split('\n')[0].slice(0, 80)}…"`);
      console.log('    plan: POST /api/outbox-update { status: "posted", externalUrl } on success');
      continue;
    }

    if (!imageUrl) {
      await updateOutbox(base, token, row.id, { status: 'failed', note: 'no image available for Instagram yet' });
      console.log(`- ${row.id} [${row.kind || '?'}] failed: no image available for Instagram yet.`);
      failed++;
      continue;
    }

    try {
      const file = await downloadImage(imageUrl, row.id);
      const url = postToInstagram(file, caption);
      await updateOutbox(base, token, row.id, { status: 'posted', ...(url ? { externalUrl: url } : {}) });
      console.log(`- ${row.id} [${row.kind || '?'}] posted to Instagram${url ? `: ${url}` : ' (no URL returned by the CLI)'}.`);
      posted++;
    } catch (e) {
      const note = String(e.message || e).slice(0, 200);
      await updateOutbox(base, token, row.id, { status: 'failed', note });
      console.log(`- ${row.id} [${row.kind || '?'}] failed: ${note}`);
      failed++;
    }
  }

  console.log(args.dryRun
    ? `Dry run done. ${planned} Instagram action(s) planned, ${leftQueued} row(s) left queued. No changes made.`
    : `Done. posted=${posted} failed=${failed} left queued=${leftQueued}.`);
}

main().catch((e) => { console.error(`poster crashed: ${e && e.message ? e.message : e}`); process.exit(1); });
