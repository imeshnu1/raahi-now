// Raahi NOW frontend (demo). Talks only to the /api endpoints in this repo.
// All payments are DEMO — methods are selected, recorded, and shown, but no
// real money moves.

const state = { markets: [], methods: [], market: 'all', drops: [], asks: [], bookings: [], wallet: null, localsByMarket: {}, user: null };
let pendingAction = null;

const $ = (s) => document.querySelector(s);

async function api(path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; e.code = data.code; throw e; }
  return data;
}

// ---------- Auth ----------
function renderHeader() {
  const area = $('#userArea');
  if (state.user) {
    const first = (state.user.name || '').split(' ')[0];
    area.innerHTML = `<span class="user-chip">Hi, ${esc(first)}</span> <button class="topbtn" id="logoutBtn">Log out</button>`;
    $('#logoutBtn').addEventListener('click', logout);
    $('#walletPill').hidden = false;
  } else {
    area.innerHTML = '<button class="topbtn" id="loginBtn">Log in</button> <button class="topbtn accent-btn" id="signupBtn">Create account</button>';
    $('#loginBtn').addEventListener('click', () => openAuth('login'));
    $('#signupBtn').addEventListener('click', () => openAuth('signup'));
    $('#walletPill').hidden = true;
  }
  renderWalletAddress();
}

async function logout() {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
  state.user = null; state.wallet = null;
  renderHeader(); renderWallet();
  loadDrops(); loadBookings();
}

function requireAuth(action) {
  if (state.user) { action(); return; }
  pendingAction = action;
  openAuth('signup');
}

function openAuth(mode) {
  openModal(`
    <h3>${mode === 'signup' ? 'Create your Raahi account' : 'Welcome back'}</h3>
    <p class="meta">One account for Drops, Asks, bookings, and your wallet. Looking around is always free — you only need an account when you want to unlock, ask, book, or pay. This is a preview, so no real money moves.</p>
    <div class="auth-tabs">
      <button type="button" class="${mode === 'signup' ? 'accent' : 'ghost'}" id="tabSignup">Create account</button>
      <button type="button" class="${mode === 'login' ? 'accent' : 'ghost'}" id="tabLogin">Log in</button>
    </div>
    <form id="authForm">
      ${mode === 'signup' ? '<label>Your name <input name="name" required autocomplete="name" placeholder="Your name"></label>' : ''}
      <label>Email <input name="email" type="email" required autocomplete="email" placeholder="you@example.com"></label>
      <label>Password <input name="password" type="password" required autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" placeholder="At least 8 characters"></label>
      <p class="auth-error" id="authError" hidden></p>
      <button class="accent" type="submit">${mode === 'signup' ? 'Create account' : 'Log in'}</button>
      <button class="ghost" type="button" id="cancelBtn">Cancel</button>
    </form>`);
  $('#tabSignup').addEventListener('click', () => openAuth('signup'));
  $('#tabLogin').addEventListener('click', () => openAuth('login'));
  $('#cancelBtn').addEventListener('click', () => { pendingAction = null; closeModal(); });
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errBox = $('#authError');
    try {
      const r = mode === 'signup'
        ? await api('/api/signup', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), email: fd.get('email'), password: fd.get('password') }) })
        : await api('/api/login', { method: 'POST', body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }) });
      state.user = r.user; state.wallet = r.wallet;
      renderHeader(); renderWallet(); fillMethodSelects();
      closeModal();
      loadDrops(); loadBookings();
      const act = pendingAction; pendingAction = null;
      if (act) act();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });
}

async function loadMe() {
  try {
    const { user } = await api('/api/me');
    state.user = user;
  } catch { state.user = null; }
  renderHeader();
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
  // QA B8: you cannot buy credits with credits — the top-up select never
  // offers 'credits' (unlocks/Asks keep the full open method list).
  const topupSel = $('#topupMethod');
  if (topupSel) {
    topupSel.innerHTML = state.methods.filter((m) => m.id !== 'credits').map((m) =>
      `<option value="${m.id}"${m.preferred ? ' selected' : ''}>${esc(m.label)}${m.note ? ' — ' + esc(m.note) : ''}</option>`).join('');
  }
}

function renderWallet() {
  const list = $('#paymentsList');
  if (!state.wallet) {
    $('#walletBalance').textContent = '–';
    list.innerHTML = state.user
      ? '<p class="muted">No payments yet.</p>'
      : '<p class="muted">Log in to see your wallet.</p>';
    return;
  }
  $('#creditCount').textContent = state.wallet.creditsBalance;
  $('#walletBalance').textContent = state.wallet.creditsBalance;
  if (!state.wallet.payments.length) { list.innerHTML = '<p class="muted">No payments yet. When you top up or unlock something, it will show up here.</p>'; return; }
  list.innerHTML = state.wallet.payments.map((p) =>
    `<div class="list-item"><strong>${esc(p.kind)}</strong> · ${esc(p.method)} · ${p.credits} credits · preview<br>
     <span class="meta">${esc(p.detail)}${p.walletAddress ? ' · wallet ' + esc(truncateAddress(p.walletAddress)) : ''} · ${new Date(p.createdAt).toLocaleString()}</span></div>`).join('');
}

async function loadWallet() {
  if (!state.user) { state.wallet = null; renderWallet(); return; }
  try {
    const { wallet } = await api('/api/wallet');
    state.wallet = wallet;
    state.methods = wallet.paymentMethods;
  } catch { state.wallet = null; }
  renderWallet();
  fillMethodSelects();
}

async function loadMethods() {
  try {
    const data = await api('/api/markets');
    state.methods = data.paymentMethods || [];
    state.markets = data.markets || state.markets;
  } catch { /* selects fill again after login */ }
  fillMethodSelects();
}

// ---------- Crypto wallet connect ----------
function truncateAddress(a) {
  const s = String(a || '');
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function renderWalletAddress() {
  const line = $('#walletAddressLine');
  if (!line) return;
  const addr = state.user && state.user.walletAddress;
  line.textContent = addr
    ? `Wallet connected: ${truncateAddress(addr)}. When you pay with crypto, we'll note this address (preview only).`
    : 'No wallet connected yet. Connect one if you\'d like to pay with Ninjji, ETH, or USDC. Any wallet is welcome.';
  const input = $('#walletAddressInput');
  if (input && addr && !input.value) input.value = addr;
}

async function saveWalletAddress(address) {
  const r = await api('/api/wallet-address', { method: 'POST', body: JSON.stringify({ address }) });
  state.user = r.user;
  renderWalletAddress();
  return r;
}

async function connectWallet() {
  const msg = $('#walletAddressMsg');
  const doConnect = async () => {
    if (window.ethereum && typeof window.ethereum.request === 'function') {
      try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const address = accounts && accounts[0];
        if (!address) { msg.textContent = 'Your wallet didn\'t share an account. Try again, or paste your address below.'; return; }
        await saveWalletAddress(address);
        msg.textContent = `All set — your wallet is connected and saved: ${truncateAddress(address)}`;
      } catch (err) {
        msg.textContent = 'That didn\'t go through — no problem. You can paste your address below instead.';
      }
    } else {
      msg.textContent = 'We couldn\'t find a browser wallet (like MetaMask). No problem — just paste your address below and save it.';
      const input = $('#walletAddressInput');
      if (input) input.focus();
    }
  };
  if (!state.user) { pendingAction = () => { document.querySelector('[data-tab="wallet"]').click(); doConnect(); }; openAuth('signup'); return; }
  await doConnect();
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
    ? `<div class="exact"><strong>Unlocked:</strong> ${esc(d.exactPlace)}<br><span class="meta">${esc(d.meetDetail || '')}</span></div>`
    : `<p class="meta">Exact spot hidden for now · around: ${esc(d.fuzzyLocation)}</p>
       <button class="accent" data-unlock="${d.id}" ${d.status !== 'live' ? 'disabled' : ''}>
         ${d.status === 'live' ? `Unlock this Drop · ${d.priceCredits} credits` : 'Closed for today'}</button>`;
  return `<article class="drop">
    <img src="${esc(d.image)}" alt="${esc(d.title)}" loading="lazy"
      onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=1200&q=70'">
    <div class="drop-body">
      <div class="badges">
        <span class="badge ${d.status === 'live' ? 'live' : 'closed'}">${d.status === 'live' ? '● Live' : d.status}</span>
        <span class="badge soft">${esc(marketName(d.marketId))}</span>
        ${d.illustrative ? '<span class="badge soft">Example Drop</span>' : ''}
        <span class="badge soft" data-countdown="${d.expiresAt}">${countdown(d.expiresAt)}</span>
        <span class="badge soft">${left} of ${d.unlockCap} unlocks left</span>
      </div>
      <h3>${esc(d.title)}</h3>
      <p>${esc(d.whyNow)}</p>
      <p class="meta">Perfect for: ${esc(d.perfectFor)} · Cost: ${esc(d.costRange)} · Time: ${esc(d.timeNeeded)}<br>Watch out: ${esc(d.warning)}</p>
      ${action}
      <p class="local-line">By <strong>${esc(local.name || '')}</strong> · ${esc(local.role || '')} · verified local<br>
      <span class="meta">${esc(local.bookingLabel || '')} · ${local.bookingPriceCredits || ''} credits · gets paid in ${esc(local.payoutCurrency || '')}</span></p>
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
    : '<p class="muted">No Drops here right now. Try another market, or check back soon.</p>';
  document.querySelectorAll('[data-unlock]').forEach((b) => b.addEventListener('click', () => requireAuth(() => openUnlock(b.dataset.unlock))));
  document.querySelectorAll('[data-book]').forEach((b) => b.addEventListener('click', () => requireAuth(() => openBook(b.dataset.book, b.dataset.drop))));
}

async function loadBookings() {
  const el = $('#bookingsList');
  if (!state.user) { state.bookings = []; el.innerHTML = '<p class="muted">Log in to see your bookings. Unlock a Drop, and you can book the local behind it.</p>'; return; }
  const { bookings } = await api('/api/bookings');
  state.bookings = bookings;
  if (!bookings.length) { el.innerHTML = '<p class="muted">No bookings yet. Unlock a Drop, and you can book the local behind it.</p>'; return; }
  el.innerHTML = bookings.map((b) =>
    `<div class="list-item"><strong>${esc(b.local ? b.local.name : b.localId)}</strong> · ${esc(b.when)} · ${b.people} people<br>
     <span class="meta">Status: ${esc(b.status)} · booking request (preview) · paying with: ${esc(b.method)}</span></div>`).join('');
}

async function loadAsks() {
  const { asks } = await api('/api/asks');
  state.asks = asks;
  const el = $('#asksList');
  if (!asks.length) { el.innerHTML = '<p class="muted">No Asks yet. Yours could be the first.</p>'; return; }
  el.innerHTML = asks.map((a) => `
    <div class="list-item">
      <strong>${esc(marketName(a.marketId))}</strong> <span class="meta">${new Date(a.createdAt).toLocaleString()}</span>
      <p>${esc(a.text)}</p>
      <p class="meta">${esc(a.hours || '')} ${a.budget ? '· budget ' + esc(a.budget) : ''}</p>
      ${(a.answers || []).map((ans) => `<div class="answer"><strong>${esc(ans.local ? ans.local.name : 'Local')}:</strong> ${esc(ans.text)}</div>`).join('')}
      <form class="answer-form" data-answer="${a.id}">
        <select name="localId">${state.drops.length || true ? localOptions(a.marketId) : ''}</select>
        <input name="text" placeholder="Your one recommendation, as this local" required>
        <button class="ghost" type="submit">Answer this Ask</button>
      </form>
    </div>`).join('');
  document.querySelectorAll('[data-answer]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.user) { requireAuth(() => f.requestSubmit()); return; }
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
    <p class="meta">Costs ${d.priceCredits} credits. The local keeps 80%, Raahi keeps 20%. This is a preview — no real money moves.</p>
    <p class="meta">${state.user && state.user.walletAddress
      ? `Your crypto wallet is connected: ${esc(truncateAddress(state.user.walletAddress))}. If you pay with crypto, we'll note this address.`
      : 'No crypto wallet connected. You can still unlock now, or connect a wallet first in the Wallet tab.'}</p>
    <form id="unlockForm">
      <label>Pay with<select name="method">${methodOptions()}</select></label>
      <button class="accent" type="submit">Unlock this Drop · ${d.priceCredits} credits</button>
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
    <p>${esc(local.bookingLabel)} · ${local.bookingPriceCredits} credits if they say yes · the local gets paid in ${esc(local.payoutCurrency)}</p>
    <p class="meta">${esc(local.bio)}</p>
    <form id="bookForm">
      <label>When <input name="when" required placeholder="Tomorrow 6:30 AM"></label>
      <label>People <input name="people" type="number" min="1" max="12" value="2"></label>
      <label>How you'd like to pay<select name="method">${methodOptions()}</select></label>
      <button class="accent" type="submit">Send booking request</button>
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
  if (!state.user) { requireAuth(() => $('#askForm').requestSubmit()); return; }
  const msg = $('#askMsg');
  try {
    const r = await api('/api/asks', { method: 'POST', body: JSON.stringify({
      marketId: $('#askMarket').value, text: $('#askText').value,
      hours: $('#askHours').value, budget: $('#askBudget').value, method: $('#askMethod').value }) });
    state.wallet = r.wallet; renderWallet();
    msg.textContent = 'Your Ask is up. Locals can answer it below.';
    e.target.reset(); fillMethodSelects(); loadAsks();
  } catch (err) { msg.textContent = err.message; }
});

$('#topupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.user) { requireAuth(() => $('#topupForm').requestSubmit()); return; }
  const msg = $('#topupMsg');
  try {
    const r = await api('/api/topup', { method: 'POST', body: JSON.stringify({ amount: Number($('#topupAmount').value), method: $('#topupMethod').value }) });
    state.wallet = r.wallet; renderWallet();
    msg.textContent = r.message;
  } catch (err) { msg.textContent = err.message; }
});

$('#connectWalletBtn').addEventListener('click', connectWallet);

$('#walletAddressForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#walletAddressMsg');
  const address = $('#walletAddressInput').value.trim();
  if (!address) { msg.textContent = 'Paste your wallet address first, then save.'; return; }
  if (!state.user) { requireAuth(async () => { try { await saveWalletAddress(address); msg.textContent = 'Saved — that address is on your account now.'; } catch (err) { msg.textContent = err.message; } }); return; }
  try {
    await saveWalletAddress(address);
    msg.textContent = 'Saved — that address is on your account now.';
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
    await loadMe();
    await loadMethods();
    await loadWallet();
    await loadDrops();
    await loadAsks();
    await loadBookings();
    renderWalletAddress();
  } catch (err) {
    $('#dropsGrid').innerHTML = `<p class="muted">Something didn't load: ${esc(err.message)}. Try refreshing the page.</p>`;
  }
})();
