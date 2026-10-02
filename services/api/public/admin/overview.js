/* Overview: the numbers an operator glances at, the onboarding funnel, the
   last two weeks, and the newest issues. */

const GAS_FLOOR_ETH = 0.001;

function issueRow(i) {
  const tone = i.severity === 'error' ? 'bad' : 'warn';
  const open = i.target
    ? i.target.kind === 'user' ? `<a href="${href('users', i.target.id)}">Open user</a>`
      : i.target.kind === 'recovery' ? `<a href="${href('recoveries', i.target.id)}">Open recovery</a>`
      : i.target.kind === 'transfer' ? `<button type="button" class="link" data-tx="${esc(i.target.id)}">Open transfer</button>`
      : `<a href="${href('errors', i.target.id)}">Stack</a>`
    : '';
  return `<div class="issue">
    <div>${pill(tone, i.source)}</div>
    <div><div class="t">${esc(i.title)}</div>
      <div class="d">${i.userName || i.userId ? `${esc(i.userName || i.userId)} · ` : ''}${esc(i.detail || '')}</div></div>
    <div class="when">${esc(fmtAgo(i.at))}<br>${open}</div>
  </div>`;
}

/* How many accounts reached each step: a stage is the first step not done,
   so an account at stage k has done every step before k. */
function funnel(stages, total) {
  const idx = (s) => (s === 'active' ? STEPS.length : STEPS.indexOf(s));
  const rows = STEPS.map((step, k) => {
    const reached = Object.entries(stages || {}).reduce((n, [s, c]) => n + (idx(s) > k ? c : 0), 0);
    const pct = total ? Math.round((reached / total) * 100) : 0;
    return `<div class="row" data-tip="${esc(`${STEP_LABEL[step]}: ${reached} of ${total} (${pct}%)`)}">
      <span>${esc(STEP_LABEL[step])}</span>
      <div class="track"><div class="fill" style="width:${pct}%"></div></div>
      <span class="num">${reached} <span class="sub2" style="display:inline">${pct}%</span></span>
    </div>`;
  }).join('');
  return `<div class="funnel">${rows}</div>`;
}

VIEWS.overview = {
  title: 'Overview',
  async load() { await Promise.all([loadOverview(), loadRecoveries()]); },
  render(root) {
    const o = S.overview;
    if (!o) { root.innerHTML = '<div class="note">No data yet.</div>'; return; }
    const gas = (o.operatorGas || []);
    const dryGas = gas.filter((w) => w.eth < GAS_FLOOR_ETH);
    const review = (S.recoveries.requests || []).filter((r) => r.status === 'REVIEW_PENDING').length;
    root.innerHTML = `
      <div class="kpis">
        <a class="card kpi" href="#/users"><span class="k">Users</span><span class="v">${o.users.total}</span><span class="s">+${o.users.new7d} in 7 days</span></a>
        <a class="card kpi good" href="${href('users', 'stage:active')}"><span class="k">IBAN active</span><span class="v">${o.users.withIban}</span><span class="s">${o.users.safesLive} Safes live</span></a>
        <a class="card kpi ${o.users.stages.iban ? 'warn' : ''}" href="#/monerium"><span class="k">Waiting on Monerium</span><span class="v">${(o.users.stages.iban || 0) + (o.users.stages.monerium || 0)}</span><span class="s">${o.monerium.connected} connected · ${o.monerium.refusals} refused</span></a>
        <a class="card kpi" href="#/transactions"><span class="k">Paid transfers</span><span class="v">${o.transfers.paid}</span><span class="s">${eur(o.transfers.volume30dEur)} in 30 days</span></a>
        <a class="card kpi ${review ? 'warn' : ''}" href="#/recoveries"><span class="k">Recoveries open</span><span class="v">${o.recoveries.open}</span><span class="s">${review} need review</span></a>
        <a class="card kpi ${o.issues.errors ? 'bad' : 'good'}" href="#/errors"><span class="k">Issues</span><span class="v">${o.issues.total}</span><span class="s">${o.issues.errors} errors · ${o.issues.last24h} in 24h</span></a>
      </div>

      ${dryGas.length ? `<div class="note bad"><b>Gas wallet dry.</b> ${dryGas.map((w) => `${esc(w.role)} <span class="chip">${esc(w.address)}</span> holds ${Number(w.eth).toFixed(5)} ETH`).join('; ')} — its transactions fail until topped up.</div>` : ''}

      <div class="grid g2">
        <section class="card"><div class="card-h"><h2>Onboarding funnel</h2><span class="sub">accounts that reached each step</span></div>
          <div class="card-b">${funnel(o.users.stages, o.users.total)}</div></section>
        <section class="card"><div class="card-h"><h2>Latest issues</h2><a class="sub" href="#/errors">All issues →</a></div>
          <div class="issues">${o.issues.latest.length ? o.issues.latest.map(issueRow).join('') : '<div class="issue"><div></div><div class="d">Nothing open.</div></div>'}</div></section>
      </div>

      <div class="grid g2">
        <section class="card"><div class="card-h"><h2>Signups</h2><span class="sub">per day, last 14 days</span></div>
          <div class="card-b">${barChart(o.users.signups, 'signups')}</div></section>
        <section class="card"><div class="card-h"><h2>Transfers created</h2><span class="sub">per day, last 14 days</span></div>
          <div class="card-b">${barChart(o.transfers.perDay, 'transfers')}</div></section>
      </div>

      <div class="grid g3">
        <section class="card"><div class="card-h"><h2>Monerium</h2></div><div class="card-b stack">
          <div><label>Profile state</label>${dist(o.monerium.profileStates, (k) => (k === 'approved' ? 'good' : ['rejected', 'blocked'].includes(k) ? 'bad' : 'warn'))}</div>
          <div><label>Connection</label>${dist(o.monerium.methods)}</div>
          <div><label>Account status (Zold)</label>${dist(o.users.kyc, (k) => (k === 'approved' ? 'good' : k === 'rejected' ? 'bad' : 'warn'))}</div>
          <div class="sub2">${o.monerium.issueOrders} incoming SEPA orders recorded · ${eur(o.monerium.issuedEur, 2)}</div>
        </div></section>
        <section class="card"><div class="card-h"><h2>Transfers</h2></div><div class="card-b stack">
          <div><label>By state</label>${dist(o.transfers.states, (k) => (k === 'PAID' ? 'good' : ['FAILED', 'MANUAL_REVIEW'].includes(k) ? 'bad' : k === 'REFUNDED' ? 'warn' : 'plain'))}</div>
          <div class="facts">${fact('Volume 7d', eur(o.transfers.volume7dEur))}${fact('Volume all time', eur(o.transfers.volumeEur))}</div>
        </div></section>
        <section class="card"><div class="card-h"><h2>Recovery & gas</h2></div><div class="card-b stack">
          <div><label>Zoldenburg guardian (live Safes)</label>${dist(o.recoveries.enrolment, (k) => (k === 'active' ? 'good' : k === 'pending' ? 'warn' : 'dim'))}</div>
          <div><label>Recovery requests</label>${dist(o.recoveries.statuses)}</div>
          <div><label>Operator gas</label>${gas.length ? gas.map((w) => `<div class="sub2">${pill(w.eth < GAS_FLOOR_ETH ? 'bad' : 'good', `${Number(w.eth).toFixed(4)} ETH`)} ${esc(w.role)}</div>`).join('') : '<span class="sub2">unreadable</span>'}</div>
        </div></section>
      </div>`;
  },
};
