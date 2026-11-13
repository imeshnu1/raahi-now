// Raahi NOW frontend (demo). Talks only to the /api endpoints in this repo.
// All payments are DEMO — methods are selected, recorded, and shown, but no
// real money moves.

const state = { markets: [], methods: [], market: 'all', drops: [], asks: [], bookings: [], wallet: null, localsByMarket: {} };

const $ = (s) => document.querySelector(s);

async function api(path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function countdown(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

function fillMethodSelects() {
  const html = state.methods.map((m) =>
    `<option value="${m.id}"${m.preferred ? ' selected' : ''}>${esc(m.label)}${m.note ? ' — ' + esc(m.note) : ''}</option>`).join('');
  document.querySelectorAll('.method-select').forEach((sel) => { sel.innerHTML = html; });
}

function renderWallet() {
  if (!state.wallet) return;
  $('#creditCount').textContent = state.wallet.creditsBalance;
  $('#walletBalance').textContent = state.wallet.creditsBalance;
  const list = $('#paymentsList');
  if (!state.wallet.payments.length) { list.innerHTML = '<p class="muted">No demo payments yet.</p>'; return; }
  list.innerHTML = state.wallet.payments.map((p) =>
    `<div class="list-item"><strong>${esc(p.kind)}</strong> · ${esc(p.method)} · ${p.credits} credits · DEMO<br>
     <span class="meta">${esc(p.detail)} · ${new Date(p.createdAt).toLocaleString()}</span></div>`).join('');
}

async function loadWallet() {
  const { wallet } = await api('/api/wallet');
  state.wallet = wallet;
  state.methods = wallet.paymentMethods;
  renderWallet();
  fillMethodSelects();
}

function marketName(id) {
  const m = state.markets.find((x) => x.id === id);
  return m ? `${m.city}, ${m.country}` : id;
}

function renderChips() {
  const chips = [{ id: 'all', city: 'All markets' }, ...state.markets];
  $('#marketChips').innerHTML = chips.map((m) =>
    `<button data-market="${m.id}" class="${state.market === m.id ? 'active' : ''}">${esc(m.city)}${m.id !== 'all' ? ' · ' + esc(m.country) : ''}</button>`).join('');
  document.querySelectorAll('#marketChips button').forEach((b) =>
    b.addEventListener('click', () => { state.market = b.dataset.market; loadDrops(); }));
  $('#askMarket').innerHTML = state.markets.map((m) => `<option value="${m.id}">${esc(m.city)}, ${esc(m.country)}</option>`).join('');
}

function dropCard(d) {
  const local = d.local || {};
  const left = d.unlocksLeft;
  const action = d.unlocked
    ? `<div class="exact"><strong>Unlocked (demo):</strong> ${esc(d.exactPlace)}<br><span class="meta">${esc(d.meetDetail || '')}</span></div>`
    : `<p class="meta">Exact place hidden · about: ${esc(d.fuzzyLocation)}</p>
       <button class="accent" data-unlock="${d.id}" ${d.status !== 'live' ? 'disabled' : ''}>
         ${d.status === 'live' ? `Unlock · ${d.priceCredits} credits` : 'Closed for today'}</button>`;
  return `<article class="drop">
    <img src="${esc(d.image)}" alt="${esc(d.title)}" loading="lazy"
      onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=1200&q=70'">
    <div class="drop-body">
      <div class="badges">
        <span class="badge ${d.status === 'live' ? 'live' : 'closed'}">${d.status === 'live' ? '● Live' : d.status}</span>
        <span class="badge soft">${esc(marketName(d.marketId))}</span>
        ${d.illustrative ? '<span class="badge soft">Illustrative example</span>' : ''}
        <span class="badge soft" data-countdown="${d.expiresAt}">${countdown(d.expiresAt)}</span>
        <span class="badge soft">${left} of ${d.unlockCap} unlocks left</span>
      </div>
      <h3>${esc(d.title)}</h3>
      <p>${esc(d.whyNow)}</p>
      <p class="meta">Perfect for: ${esc(d.perfectFor)} · Cost: ${esc(d.costRange)} · Time: ${esc(d.timeNeeded)}<br>Watch out: ${esc(d.warning)}</p>
      ${action}
      <p class="local-line">By <strong>${esc(local.name || '')}</strong> · ${esc(local.role || '')} · verified local<br>
      <span class="meta">${esc(local.bookingLabel || '')} · ${local.bookingPriceCredits || ''} credits · payout in ${esc(local.payoutCurrency || '')}</span></p>
      <button class="ghost" data-book="${local.id}" data-drop="${d.id}">Book ${esc(local.name || 'this person')}</button>
    </div>
  </article>`;
}

async function loadDrops() {
  const data = await api(`/api/drops?market=${encodeURIComponent(state.market)}`);
  state.markets = data.markets;
  state.drops = data.drops;
  renderChips();
  $('#dropsGrid').innerHTML = state.drops.length
    ? state.drops.map(dropCard).join('')
    : '<p class="muted">No Drops in this market right now.</p>';
  document.querySelectorAll('[data-unlock]').forEach((b) => b.addEventListener('click', () => openUnlock(b.dataset.unlock)));
  document.querySelectorAll('[data-book]').forEach((b) => b.addEventListener('click', () => openBook(b.dataset.book, b.dataset.drop)));
}

async function loadBookings() {
  const { bookings } = await api('/api/bookings');
  state.bookings = bookings;
  const el = $('#bookingsList');
  if (!bookings.length) { el.innerHTML = '<p class="muted">No bookings yet. Unlock a Drop and book the person behind it.</p>'; return; }
  el.innerHTML = bookings.map((b) =>
    `<div class="list-item"><strong>${esc(b.local ? b.local.name : b.localId)}</strong> · ${esc(b.when)} · ${b.people} people<br>
     <span class="meta">Status: ${esc(b.status)} · DEMO booking request · pay method on file: ${esc(b.method)}</span></div>`).join('');
}

async function loadAsks() {
  const { asks } = await api('/api/asks');
  state.asks = asks;
  const el = $('#asksList');
  if (!asks.length) { el.innerHTML = '<p class="muted">No Asks yet.</p>'; return; }
  el.innerHTML = asks.map((a) => `
    <div class="list-item">
      <strong>${esc(marketName(a.marketId))}</strong> <span class="meta">${new Date(a.createdAt).toLocaleString()}</span>
      <p>${esc(a.text)}</p>
      <p class="meta">${esc(a.hours || '')} ${a.budget ? '· budget ' + esc(a.budget) : ''}</p>
      ${(a.answers || []).map((ans) => `<div class="answer"><strong>${esc(ans.local ? ans.local.name : 'Local')}:</strong> ${esc(ans.text)}</div>`).join('')}
      <form class="answer-form" data-answer="${a.id}">
        <select name="localId">${state.drops.length || true ? localOptions(a.marketId) : ''}</select>
        <input name="text" placeholder="Your one recommendation as this local" required>
        <button class="ghost" type="submit">Answer this Ask</button>
      </form>
    </div>`).join('');
  document.querySelectorAll('[data-answer]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    try {
      await api('/api/answer', { method: 'POST', body: JSON.stringify({ askId: f.dataset.answer, localId: fd.get('localId'), text: fd.get('text') }) });
      loadAsks();
    } catch (err) { alert(err.message); }
  }));
}

function localOptions(marketId) {
  // Locals come from the Drops board data (each Drop carries its local).
  const seen = new Map();
  state.drops.forEach((d) => { if (d.local) seen.set(d.local.id, d.local); });
  const all = [...seen.values()];
  const inMarket = all.filter((l) => l.id && state.drops.some((d) => d.marketId === marketId && d.local && d.local.id === l.id));
  const list = inMarket.length ? inMarket : all;
  return list.map((l) => `<option value="${l.id}">${esc(l.name)} · ${esc(l.role)}</option>`).join('');
}

// ---------- Modals ----------
function openModal(html) { $('#modalBox').innerHTML = html; $('#modalBackdrop').hidden = false; }
function closeModal() { $('#modalBackdrop').hidden = true; }
$('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });

function methodOptions(selected) {
  return state.methods.map((m) => `<option value="${m.id}"${m.id === selected || (!selected && m.preferred) ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
}

function openUnlock(dropId) {
  const d = state.drops.find((x) => x.id === dropId);
  if (!d) return;
  openModal(`
    <h3>Unlock this Drop</h3>
    <p>${esc(d.title)}</p>
    <p class="meta">Costs ${d.priceCredits} demo credits. The local keeps 80%, Raahi keeps 20%. No real money moves.</p>
    <form id="unlockForm">
      <label>Pay with (demo, open payments)<select name="method">${methodOptions()}</select></label>
      <button class="accent" type="submit">Unlock · ${d.priceCredits} credits</button>
      <button class="ghost" type="button" id="cancelBtn">Cancel</button>
    </form>`);
  $('#cancelBtn').addEventListener('click', closeModal);
  $('#unlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const method = new FormData(e.target).get('method');
    try {
      const r = await api('/api/unlock', { method: 'POST', body: JSON.stringify({ dropId, method }) });
      state.wallet = r.wallet; renderWallet();
      closeModal(); loadDrops();
    } catch (err) { alert(err.message); }
  });
}

function openBook(localId, dropId) {
  const d = state.drops.find((x) => x.local && x.local.id === localId);
  const local = d ? d.local : null;
  if (!local) return;
  openModal(`
    <h3>Book ${esc(local.name)}</h3>
    <p>${esc(local.bookingLabel)} · ${local.bookingPriceCredits} credits if confirmed · payout to the local in ${esc(local.payoutCurrency)}</p>
    <p class="meta">${esc(local.bio)}</p>
    <form id="bookForm">
      <label>When <input name="when" required placeholder="Tomorrow 6:30 AM"></label>
      <label>People <input name="people" type="number" min="1" max="12" value="2"></label>
      <label>Preferred pay method (demo)<select name="method">${methodOptions()}</select></label>
      <button class="accent" type="submit">Send booking request (demo)</button>
      <button class="ghost" type="button" id="cancelBtn">Cancel</button>
    </form>`);
  $('#cancelBtn').addEventListener('click', closeModal);
  $('#bookForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/bookings', { method: 'POST', body: JSON.stringify({ localId, dropId, when: fd.get('when'), people: fd.get('people'), method: fd.get('method') }) });
      closeModal(); loadBookings();
      document.querySelector('[data-tab="drops"]').click();
    } catch (err) { alert(err.message); }
  });
}

// ---------- Forms & tabs ----------
$('#askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#askMsg');
  try {
    const r = await api('/api/asks', { method: 'POST', body: JSON.stringify({
      marketId: $('#askMarket').value, text: $('#askText').value,
      hours: $('#askHours').value, budget: $('#askBudget').value, method: $('#askMethod').value }) });
    state.wallet = r.wallet; renderWallet();
    msg.textContent = 'Ask posted (demo). Locals can answer it below.';
    e.target.reset(); fillMethodSelects(); loadAsks();
  } catch (err) { msg.textContent = err.message; }
});

$('#topupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#topupMsg');
  try {
    const r = await api('/api/topup', { method: 'POST', body: JSON.stringify({ amount: Number($('#topupAmount').value), method: $('#topupMethod').value }) });
    state.wallet = r.wallet; renderWallet();
    msg.textContent = r.message;
  } catch (err) { msg.textContent = err.message; }
});

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
}));

// Live countdown refresh, once a minute.
setInterval(() => {
  document.querySelectorAll('[data-countdown]').forEach((el) => { el.textContent = countdown(el.dataset.countdown); });
}, 60000);

(async () => {
  try {
    await loadWallet();
    await loadDrops();
    await loadAsks();
    await loadBookings();
  } catch (err) {
    $('#dropsGrid').innerHTML = `<p class="muted">Could not load: ${esc(err.message)}</p>`;
  }
})();
