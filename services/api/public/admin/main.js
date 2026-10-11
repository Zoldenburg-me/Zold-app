/* Wiring: the operator's passkey and the read-only token, routing, the
   refresh loop. Last file: everything it calls is declared above. */

const viewRoot = document.getElementById('view');
const updatedAt = document.getElementById('updatedAt');
let seq = 0;
let inFlight = 0;
const REFRESH_EVERY_MS = 15_000;
const BADGES_EVERY_MS = 60_000;
let badgesAt = 0;

// The operator token is kept for this tab only: any same-origin script can
// read localStorage. Debounced: a request per keystroke would fire a 401 for
// every prefix of the token.
localStorage.removeItem('zold_operator_token');
tokenInput.value = sessionStorage.getItem('zold_operator_token') || '';
let tokenTimer;
tokenInput.addEventListener('input', () => {
  sessionStorage.setItem('zold_operator_token', tokenInput.value);
  clearTimeout(tokenTimer);
  tokenTimer = setTimeout(() => refresh(true), 400);
});

const signInBtn = document.getElementById('signInBtn');
const addPasskeyBtn = document.getElementById('addPasskeyBtn');
const signOutBtn = document.getElementById('signOutBtn');

/** The ceremonies that open a session carry no bearer. */
async function authPost(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

function showAuth() {
  const on = Boolean(operatorSession);
  signInBtn.hidden = on;
  addPasskeyBtn.hidden = !on;
  signOutBtn.hidden = !on;
  document.getElementById('tokenLabel').hidden = on;
  setAuth(on || tokenInput.value.trim() ? 'ok' : 'none');
}

function showProblem(err) {
  const msg = err?.name === 'NotAllowedError' ? 'The passkey prompt was closed or timed out.' : (err?.message || String(err));
  viewRoot.insertAdjacentHTML('afterbegin', `<div class="note bad">${esc(msg)}</div>`);
}

async function loadMe() {
  operatorName = '';
  if (operatorSession) {
    try { operatorName = (await api('/api/admin/auth/me')).operator?.name || ''; } catch { /* a dead session is cleared by api() */ }
  }
  showAuth();
}

async function signIn() {
  try {
    const o = await authPost('/api/admin/auth/login/challenge');
    const r = await authPost('/api/admin/auth/login', await assertOperatorPasskey(o));
    setOperatorSession(r.sessionToken);
    operatorName = r.operator?.name || '';
    rejectedToken = null;
    showAuth();
    refresh(true);
  } catch (err) { showProblem(err); }
}

async function signOut() {
  try { await api('/api/admin/auth/logout', { method: 'POST', body: '{}' }); } catch { /* ending it locally is enough */ }
  setOperatorSession('');
  operatorName = '';
  clearData();
  showAuth();
  refresh(true);
}

/** A backup passkey: created, then approved by one the operator already has. */
async function addPasskey() {
  const label = (window.prompt('Name this passkey (for example "YubiKey, drawer")', 'Backup passkey') || '').trim();
  if (!label) return;
  try {
    const o = await api('/api/admin/auth/passkeys/challenge', { method: 'POST', body: '{}' });
    const body = JSON.stringify({ label, ...(await createOperatorPasskey(o)) });
    const approval = await approveChange('/api/admin/auth/passkeys', 'POST', body);
    const r = await api('/api/admin/auth/passkeys', { method: 'POST', body, headers: { 'X-Operator-Step-Up': approval } });
    viewRoot.insertAdjacentHTML('afterbegin', `<div class="note">Passkey added. You now have ${esc(r.operator.passkeys.length)}.</div>`);
  } catch (err) { showProblem(err); }
}

/** An enrolment link from the host: /admin#enrol=<token>. The token is read
 *  once and taken out of the address bar before anything else runs. */
const enrolToken = new URLSearchParams(location.hash.slice(1)).get('enrol');
if (enrolToken) history.replaceState(null, '', location.pathname);

function showEnrolment() {
  viewRoot.innerHTML = `
    <div class="note">
      <p><strong>Create your operator passkey.</strong> This link works once, for 15 minutes, and only for the person it was made for.</p>
      <p><label>Name for this passkey <input type="text" id="enrolLabel" value="Primary passkey" maxlength="60"></label></p>
      <p><button type="button" class="btn" id="enrolBtn">Create passkey</button></p>
    </div>`;
  document.getElementById('enrolBtn').addEventListener('click', async () => {
    try {
      const o = await authPost('/api/admin/auth/enrol/challenge', { token: enrolToken });
      const att = await createOperatorPasskey(o);
      const r = await authPost('/api/admin/auth/enrol', { token: enrolToken, label: document.getElementById('enrolLabel').value, ...att });
      setOperatorSession(r.sessionToken);
      operatorName = r.operator?.name || '';
      showAuth();
      onRoute();
      viewRoot.insertAdjacentHTML('afterbegin', '<div class="note">Passkey created. Add a backup passkey next, from "Add passkey".</div>');
    } catch (err) { showProblem(err); }
  });
}

window.addEventListener('operator-session-ended', showAuth);
signInBtn.addEventListener('click', signIn);
signOutBtn.addEventListener('click', signOut);
addPasskeyBtn.addEventListener('click', addPasskey);

function markNav() {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === route.view;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.getElementById('viewTitle').textContent = VIEWS[route.view].title;
  document.title = `${VIEWS[route.view].title} · Zold Operator`;
}

/* Load the current view's data (and the overview, for the nav badges), then
   draw. `force` redraws even when the operator is working in the view. */
async function refresh(force) {
  const v = VIEWS[route.view];
  if (!force && (document.hidden || inFlight || isModalOpen() || v.busy?.() || viewRoot.contains(document.activeElement) && document.activeElement.matches('textarea, input'))) return;
  const mine = ++seq;
  inFlight++;
  const { view, arg } = route;
  try {
    // Nav badges need the overview and the recoveries; they load beside the
    // view and never hold its first draw (the overview reads gas over RPC).
    // They change slowly: a background refresh reloads them once a minute.
    const badgesDue = force || Date.now() - badgesAt >= BADGES_EVERY_MS;
    if (badgesDue) badgesAt = Date.now();
    if (badgesDue && view !== 'overview') loadOverview().then(setNavBadges, () => {});
    if (badgesDue && view !== 'recoveries' && view !== 'overview') loadRecoveries().then(setNavBadges, () => {});
    await v.load(arg);
    if (mine !== seq) return;
    // A redraw of the same page keeps the sections the operator opened.
    const open = force ? null : [...viewRoot.querySelectorAll('details')].map((d) => d.open);
    v.render(viewRoot, arg);
    const now = [...viewRoot.querySelectorAll('details')];
    if (open && open.length === now.length) now.forEach((d, i) => { d.open = open[i]; });
    updatedAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    if (mine === seq) {
      viewRoot.innerHTML = `<div class="note ${err.status === 401 ? 'warn' : 'bad'}">${esc(err.status === 401 ? 'Sign in with your operator passkey, or enter the read-only token.' : err.status === 503 ? err.message : `Could not load: ${err.message}`)}</div>`;
    }
  } finally {
    inFlight--;
    setNavBadges();
  }
}

function onRoute() {
  route = parseRoute();
  markNav();
  viewRoot.innerHTML = '<div class="note">Loading…</div>';
  refresh(true);
  viewRoot.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

viewRoot.addEventListener('click', (ev) => VIEWS[route.view].click?.(ev, viewRoot, route.arg));
document.getElementById('refreshBtn').addEventListener('click', () => refresh(true));
window.addEventListener('hashchange', onRoute);

if (enrolToken) {
  route = parseRoute();
  markNav();
  showEnrolment();
} else {
  onRoute();
}
loadMe();
const backgroundRefresh = () => {
  if (enrolToken && !operatorSession) return;
  if ((operatorSession || tokenInput.value.trim()) !== rejectedToken) refresh(false);
};
setInterval(backgroundRefresh, REFRESH_EVERY_MS);
// A hidden tab skips its refreshes and catches up when it is shown again.
document.addEventListener('visibilitychange', () => { if (!document.hidden) backgroundRefresh(); });
