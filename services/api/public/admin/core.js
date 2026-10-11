/**
 * The operator dashboard: shared state, the API client, helpers and the
 * router. Classic scripts sharing one scope, in the order admin.html loads
 * them; every file but main.js only declares and registers, and nothing calls
 * forward into a later file.
 *
 * Read only, with TWO exceptions. Recoveries, where an operator reviews a
 * person who lost their passkey and signs as Zoldenburg's guardian from the
 * Keycard Shell; and Transactions, where an operator records how a transfer in
 * MANUAL_REVIEW was resolved (no money moves). KYC review and IBAN issue
 * belong to Monerium.
 *
 * Three security details. The operator signs in with a passkey; the session
 * token lives in sessionStorage so it does not outlive the tab, and every
 * change asks the passkey again, bound to that exact request. The shared
 * operator token still opens the dashboard read-only. Every value from the
 * API is escaped, and rows carry ids for delegated listeners — never an inline
 * handler built from row data, since a signup name containing a quote can
 * close a JS string (stored XSS next to that session).
 */

/* ---------- state ---------- */

const S = {
  overview: null,
  users: [],
  txs: [],
  recoveries: { enabled: false, requests: [], enrolments: [] },
  issues: [],
  serverErrors: [],
  monerium: null,
  /** userId → { detail, monerium, live } */
  userCache: {},
};

/** view name → { title, load(arg): Promise, render(root, arg) } */
const VIEWS = {};
let route = { view: 'overview', arg: '' };

/* ---------- helpers ---------- */

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return !iso || isNaN(d) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtAgo(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  const fut = s < 0;
  const a = Math.abs(s);
  const txt = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return fut ? `in ${txt}` : `${txt} ago`;
}

const eur = (n, d = 0) => `€${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '—');
const pill = (tone, label) => `<span class="pill ${tone}">${esc(label)}</span>`;
const chip = (v) => (v ? `<span class="chip" translate="no">${esc(v)}</span>` : '—');
const fact = (k, v, raw) => `<div><div class="k">${esc(k)}</div><div class="v">${raw ? (v || '—') : esc(v ?? '—')}</div></div>`;
const empty = (cols, text) => `<tr><td class="empty" colspan="${cols}">${esc(text)}</td></tr>`;

const STEPS = ['account', 'passkey', 'safe', 'recovery', 'monerium', 'iban'];
const STEP_LABEL = {
  account: 'Account', passkey: 'Passkey', safe: 'Safe', recovery: 'Recovery choice',
  monerium: 'Monerium', iban: 'IBAN', active: 'Active',
};
/** The stage is the first step NOT done: "at Monerium" means waiting there. */
const STAGE_LABEL = {
  passkey: 'Needs passkey', safe: 'Needs Safe', recovery: 'Needs recovery choice',
  monerium: 'Needs Monerium', iban: 'Waiting for IBAN', active: 'Active',
};
function stagePill(onb) {
  const st = onb?.stage || 'passkey';
  return pill(st === 'active' ? 'good' : st === 'iban' || st === 'monerium' ? 'warn' : 'dim', STAGE_LABEL[st] || st);
}
function stepDots(onb) {
  return `<span class="steps" aria-hidden="true">${STEPS.map((s) => `<i class="${onb?.done?.[s] ? 'on' : ''}"></i>`).join('')}</span>`;
}

function kycPill(s) {
  return pill(s === 'approved' ? 'good' : s === 'rejected' ? 'bad' : 'warn', s || 'unknown');
}
/** Monerium profile states: approved, pending, rejected, blocked, created… */
function profilePill(s) {
  if (!s) return pill('dim', 'no profile');
  return pill(s === 'approved' ? 'good' : ['rejected', 'blocked'].includes(s) ? 'bad' : 'warn', s);
}
function enrolPill(z) {
  return {
    active: pill('good', 'Zoldenburg guardian'),
    pending: pill('warn', 'guardian pending'),
    declined: pill('dim', 'declined'),
    not_asked: pill('dim', 'not asked'),
  }[z] || pill('dim', z || '—');
}

const ATTENTION_STATES = ['FAILED', 'REFUNDED', 'REFUSED', 'UNCONFIRMED', 'MANUAL_REVIEW'];
const TERMINAL_STATES = ['PAID', 'CONVERTED', ...ATTENTION_STATES];
const STALE_MS = 30 * 60_000;
const isInflight = (t) => t.kind !== 'funding' && !TERMINAL_STATES.includes(t.state);
const isStale = (t) => isInflight(t) && Date.now() - (Date.parse(t.updatedAt || t.createdAt || '') || 0) > STALE_MS;
function txPill(t) {
  if (['PAID', 'CONVERTED'].includes(t.state)) return pill('good', t.state);
  if (ATTENTION_STATES.includes(t.state)) return pill(t.state === 'REFUNDED' ? 'warn' : 'bad', t.state);
  return pill(isStale(t) ? 'warn' : 'dim', isStale(t) ? `${t.state} · stuck` : t.state || 'unknown');
}
function railLabel(t) {
  if (t.kind === 'funding') return `${t.token || 'Token'} deposit`;
  if (t.rail === 'sepa') return 'SEPA · Monerium';
  if (t.rail === 'cash') return 'Cash · MoneyGram';
  return t.rail || '—';
}
function amountLabel(t) {
  if (t.kind === 'funding') return t.token === 'USDC' ? `+${Number(t.amountUsdc || 0).toFixed(2)} USDC` : `+${eur(t.amountEur, 2)}`;
  if (t.rail === 'sepa') return eur(t.sendEur, 2);
  return `${eur(t.sendEur, 2)} → KES ${Number(t.receiveKes || 0).toLocaleString()}`;
}

/* A single-series bar chart: one hue, the value on hover, a zero bar drawn
   as a hairline so an empty day still reads as a day. */
function barChart(series, label) {
  const max = Math.max(1, ...series.map((x) => x.count));
  const cols = series.map((x) => {
    const h = Math.round((x.count / max) * 100);
    return `<div class="col" data-tip="${esc(`${x.day.slice(5)} · ${x.count} ${label}`)}"><i class="${x.count ? '' : 'zero'}" style="height:${x.count ? Math.max(4, h) : 2}%"></i></div>`;
  }).join('');
  const first = series[0]?.day.slice(5) || '';
  const last = series.at(-1)?.day.slice(5) || '';
  return `<div class="chart" role="img" aria-label="${esc(`${label} per day: ${series.map((x) => `${x.day} ${x.count}`).join(', ')}`)}">${cols}</div>
    <div class="axis"><span>${esc(first)}</span><span>max ${max}</span><span>${esc(last)}</span></div>`;
}

function dist(obj, toneOf = () => 'plain') {
  const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<span class="sub2">none</span>';
  return `<div class="dist">${entries.map(([k, v]) => `<span class="pill ${toneOf(k)}">${esc(k)} · ${v}</span>`).join('')}</div>`;
}

/* ---------- API ---------- */

const tokenInput = document.getElementById('operatorToken');
const authPill = document.getElementById('authPill');
const authText = document.getElementById('authText');
/** The last token the server refused. The background refresh does not resend
 *  it; a password manager that fills the field would otherwise get a 401
 *  every 15 seconds. */
let rejectedToken = null;

/** The operator's passkey session, for this tab only. */
const SESSION_KEY = 'zold_operator_session';
let operatorSession = sessionStorage.getItem(SESSION_KEY) || '';
/** Who the session is, once /api/admin/auth/me has answered. */
let operatorName = '';

function setOperatorSession(token) {
  operatorSession = token || '';
  if (operatorSession) sessionStorage.setItem(SESSION_KEY, operatorSession);
  else sessionStorage.removeItem(SESSION_KEY);
}

function setAuth(state) {
  authPill.className = `auth ${state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : ''}`;
  authText.textContent = state === 'bad' ? 'Unauthorized'
    : state !== 'ok' ? 'Signed out'
    : operatorSession ? (operatorName || 'Signed in') : 'Read-only token';
}

/** Stale rows under a dead token read as live ops data: drop them. */
function clearData() {
  S.overview = null; S.users = []; S.txs = []; S.issues = []; S.serverErrors = []; S.monerium = null; S.userCache = {};
  S.recoveries = { enabled: false, requests: [], enrolments: [] };
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** A fresh passkey approval for one change: the server binds the challenge
 *  to this method, path and body, and the request carries the answer. */
async function approveChange(path, method, bodyText) {
  const o = await api('/api/admin/auth/step-up/challenge', {
    method: 'POST',
    body: JSON.stringify({ method, path: path.split('?')[0], body: bodyText ? JSON.parse(bodyText) : undefined }),
  });
  const a = await assertOperatorPasskey(o);
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(a)));
}

async function api(path, options = {}) {
  const token = operatorSession || tokenInput.value.trim();
  if (!token) { setAuth('none'); throw new ApiError(401, 'Sign in with your operator passkey.'); }
  const method = (options.method || 'GET').toUpperCase();
  const approval = {};
  if (method !== 'GET' && !path.startsWith('/api/admin/auth/')) {
    if (!operatorSession) throw new ApiError(403, 'Sign in with your operator passkey to make a change: the operator token only reads.');
    approval['X-Operator-Step-Up'] = await approveChange(path, method, options.body);
  }
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...approval, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // An ended passkey session falls back to the token, if one is entered. An
    // Access refusal leaves the session alone: signing in to Access again is
    // enough. main.js redraws the sign-in controls on the event.
    const ended = operatorSession && token === operatorSession && data.code === 'OPERATOR_SIGN_IN';
    if (ended) {
      setOperatorSession('');
      operatorName = '';
    }
    // After an Access refusal the background refresh keeps trying: signing in
    // to Access again in another tab is enough.
    if (data.code !== 'ACCESS_REQUIRED') rejectedToken = token;
    setAuth('bad');
    clearData();
    if (ended) window.dispatchEvent(new Event('operator-session-ended'));
  } else if (res.status === 403 && method === 'GET') {
    rejectedToken = token;
    setAuth('bad');
    clearData();
  } else {
    rejectedToken = null;
    setAuth('ok');
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------- loaders shared by several views ---------- */

async function loadOverview() { S.overview = await api('/api/admin/overview'); }
async function loadUsers() { S.users = await api('/api/admin/users'); }
async function loadTxs() { S.txs = (await api('/api/admin/transactions?limit=500')).transactions || []; }
async function loadRecoveries() { S.recoveries = await api('/api/admin/recoveries'); }
async function loadIssues() {
  const [i, e] = await Promise.all([api('/api/admin/issues'), api('/api/admin/errors')]);
  S.issues = i.issues || [];
  S.serverErrors = e.errors || [];
}

/* ---------- navigation ---------- */

function href(view, arg) { return `#/${view}${arg ? `/${encodeURIComponent(arg)}` : ''}`; }
function go(view, arg) { location.hash = href(view, arg); }

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h) {
    const [view, ...rest] = h.split('/');
    return { view: VIEWS[view] ? view : 'overview', arg: rest.length ? decodeURIComponent(rest.join('/')) : '' };
  }
  // /admin/recoveries etc. open that section.
  const fromPath = location.pathname.replace(/^\/admin\/?/, '').replace(/\/$/, '');
  return { view: VIEWS[fromPath] ? fromPath : 'overview', arg: '' };
}

function setNavBadges() {
  const pending = (S.recoveries.requests || []).filter((r) => r.status === 'REVIEW_PENDING').length;
  document.getElementById('navRecoveries').textContent = pending || '';
  const errs = S.overview?.issues?.errors ?? S.issues.filter((i) => i.severity === 'error').length;
  document.getElementById('navErrors').textContent = errs || '';
  const n = S.overview?.users?.total ?? S.users.length;
  document.getElementById('navUsers').textContent = n || '';
  if (S.overview) {
    document.getElementById('sideFoot').textContent = `chain ${S.overview.chainId}`;
  }
}

/* ---------- raw-data modal ---------- */

let modalOpener = null;
const modalOverlay = document.getElementById('modalOverlay');
const isModalOpen = () => modalOverlay.classList.contains('open');

function openModal(title, data) {
  modalOpener = document.activeElement;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalJson').textContent = JSON.stringify(data, null, 2);
  modalOverlay.classList.add('open');
  document.getElementById('modalTitle').focus();
}
function closeModal() {
  if (!isModalOpen()) return;
  modalOverlay.classList.remove('open');
  if (modalOpener?.isConnected) modalOpener.focus();
  modalOpener = null;
}
document.getElementById('modalClose').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (ev) => { if (ev.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', (ev) => {
  if (!isModalOpen()) return;
  if (ev.key === 'Escape') { ev.preventDefault(); closeModal(); }
  // The close button is the modal's only control.
  if (ev.key === 'Tab') { ev.preventDefault(); document.getElementById('modalClose').focus(); }
});

/* ---------- chart tooltip ---------- */

const tip = document.getElementById('chartTip');
document.addEventListener('mouseover', (ev) => {
  const el = ev.target.closest('[data-tip]');
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
  tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 6)}px`;
});

/* Shared row actions: open a user, a transaction's raw record. */
document.addEventListener('click', (ev) => {
  const u = ev.target.closest('[data-user]');
  if (u && !ev.target.closest('a,button:not([data-user])')) { go('users', u.dataset.user); return; }
  const t = ev.target.closest('[data-tx]');
  if (t) {
    const tx = S.txs.find((x) => x.id === t.dataset.tx)
      || Object.values(S.userCache).flatMap((c) => c.detail?.transactions || []).find((x) => x.id === t.dataset.tx);
    if (tx) openModal(`Transaction ${tx.id}`, tx);
    else go('transactions');
  }
});
