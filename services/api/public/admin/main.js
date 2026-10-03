/* Wiring: token, routing, the refresh loop. Last file: everything it calls
   is declared above. */

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
      viewRoot.innerHTML = `<div class="note ${err.status === 401 ? 'warn' : 'bad'}">${esc(err.status === 401 ? 'Enter a valid operator token to load the dashboard.' : err.status === 503 ? err.message : `Could not load: ${err.message}`)}</div>`;
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

onRoute();
const backgroundRefresh = () => { if (tokenInput.value.trim() !== rejectedToken) refresh(false); };
setInterval(backgroundRefresh, REFRESH_EVERY_MS);
// A hidden tab skips its refreshes and catches up when it is shown again.
document.addEventListener('visibilitychange', () => { if (!document.hidden) backgroundRefresh(); });
