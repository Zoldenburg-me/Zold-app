/* Monerium across the deployment: how this deployment talks to Monerium,
   every connected account and its profile state, company accounts backed by a
   Monerium profile, incoming and outgoing SEPA orders, and the partner audit
   trail. Per-person detail (and the live read) is on the user's page. */

let monQuery = '';
let monLive = null;

function renderMonerium(root) {
  const m = S.monerium;
  if (!m) { root.innerHTML = '<div class="note">No data yet.</div>'; return; }
  const d = m.deployment;
  const q = monQuery.toLowerCase();
  const accounts = m.accounts.filter((a) => !q || [a.name, a.email, a.userId, a.profileId, a.iban].filter(Boolean).join(' ').toLowerCase().includes(q));
  const states = {};
  for (const a of m.accounts) states[a.profileState || 'no profile'] = (states[a.profileState || 'no profile'] || 0) + 1;
  const app = monLive;
  root.innerHTML = `
    <div class="kpis">
      <div class="card kpi"><span class="k">Connected accounts</span><span class="v">${m.accounts.filter((a) => a.connectedAt).length}</span><span class="s">${m.accounts.filter((a) => a.method === 'api_keys').length} on own API keys</span></div>
      <div class="card kpi good"><span class="k">Profiles approved</span><span class="v">${states.approved || 0}</span><span class="s">${Object.entries(states).filter(([k]) => k !== 'approved').map(([k, v]) => `${v} ${k}`).join(' · ') || '—'}</span></div>
      <div class="card kpi ${m.accounts.some((a) => a.refusal) ? 'warn' : ''}"><span class="k">Connect refusals</span><span class="v">${m.accounts.filter((a) => a.refusal).length}</span><span class="s">last refusal per account</span></div>
      <div class="card kpi"><span class="k">Incoming SEPA</span><span class="v">${m.issueOrders.length}</span><span class="s">${eur(m.issueOrders.reduce((s, r) => s + (r.amountEur || 0), 0), 2)} recorded</span></div>
      <div class="card kpi"><span class="k">Outgoing SEPA</span><span class="v">${m.redeemOrders.length}</span><span class="s">${m.redeemOrders.filter((r) => r.state === 'processed').length} processed</span></div>
    </div>

    <section class="card"><div class="card-h"><h2>Deployment</h2>
      <button type="button" class="btn sm" data-mon-check>${app ? 'Check again' : 'Check app credentials live'}</button></div>
      <div class="card-b stack">
        <div class="facts">
          ${fact('Environment', pill(d.environment === 'production' ? 'good' : 'warn', d.environment), true)}
          ${fact('API', d.baseUrl)}
          ${fact('Chain', `${d.chain} (${d.chainId})`)}
          ${fact('App credentials', pill(d.appCredentials ? 'good' : 'bad', d.appCredentials ? 'set' : 'missing'), true)}
          ${fact('OAuth', pill(d.oauth ? 'good' : 'dim', d.oauth ? 'enabled' : 'off'), true)}
          ${fact('Webhook signature', pill(d.webhookSecret ? 'good' : 'warn', d.webhookSecret ? 'verified' : 'no secret'), true)}
          ${fact('Token encryption', pill(d.tokenEncryption ? 'good' : 'warn', d.tokenEncryption ? 'key set' : 'no key — API keys off'), true)}
          ${fact('Deposit poll', `${Math.round(d.pollMs / 1000)}s`)}
          ${fact('OAuth redirect', d.redirectUri)}
        </div>
        ${app ? (app.ok
          ? `<div class="note"><span class="ok-msg">App credentials work.</span><details><summary>Auth context</summary><pre class="json">${esc(JSON.stringify(app.data, null, 2))}</pre></details></div>`
          : `<div class="note bad">Monerium refused the app credentials: ${esc(app.error)}</div>`) : ''}
      </div></section>

    <section class="card"><div class="card-h"><h2>Accounts at Monerium</h2>
      <input type="search" id="monSearch" aria-label="Search Monerium accounts" placeholder="Name, email, profile id, IBAN" value="${esc(monQuery)}"></div>
      ${objTable(accounts, [
        ['User', (a) => `<span class="who"><b>${esc(a.name || 'Unnamed')}</b><span>${esc(a.email || a.userId)}</span></span>`],
        ['Connection', (a) => (a.connectedAt ? `${esc(a.method || 'oauth')}<span class="sub2">${esc(fmtWhen(a.connectedAt))}</span>` : pill('dim', 'not connected'))],
        ['Profile', (a) => `${profilePill(a.profileState)}<span class="sub2">${esc(a.profileId || '')}</span>`],
        ['IBAN', (a) => (a.iban ? `${chip(a.iban)}<span class="sub2">${esc(a.bic || '')}</span>` : '<span class="sub2">none</span>')],
        ['Funding', (a) => (a.fundingStatus ? pill(a.fundingStatus === 'active' ? 'good' : a.fundingStatus === 'error' ? 'bad' : 'warn', a.fundingStatus) : '—')],
        ['Stored', (a) => `<span class="sub2">${a.ibans} IBANs · ${a.addresses} addresses</span>`],
        ['Problem', (a) => esc(a.refusal ? `${a.refusal.code}: ${a.refusal.error}` : a.addressUnlinkable ? 'address unlinkable' : a.fundingDetail || '—')],
        ['', (a) => `<a href="${href('users', a.userId)}">Open</a>`],
      ], 'No account has connected Monerium.')}</section>

    ${m.orgAccounts.length ? `<section class="card"><div class="card-h"><h2>Company accounts backed by Monerium</h2></div>
      ${objTable(m.orgAccounts, [
        ['Organisation', (a) => esc(a.org || a.orgId)], ['Account', (a) => esc(a.label)], ['Status', (a) => pill(a.status === 'active' ? 'good' : 'warn', a.status)],
        ['Profile', (a) => (a.profile ? `${chip(a.profile.id)} ${esc(a.profile.kind)}<span class="sub2">${esc(a.profile.name || '')} · checked ${esc(fmtWhen(a.profile.checkedAt))}</span>` : '—')],
        ['Backing user', (a) => (a.backingUserId ? `<a href="${href('users', a.backingUserId)}">${esc(a.backingUserId)}</a>` : '—')],
        ['Detail', (a) => esc(a.detail || '—')],
      ])}</section>` : ''}

    <section class="card"><div class="card-h"><h2>Incoming SEPA — issue orders</h2><span class="sub">bank transfers in that minted EURe</span></div>${issueOrdersTable(m.issueOrders, true)}</section>
    <section class="card"><div class="card-h"><h2>Outgoing SEPA — redeem orders</h2><span class="sub">payouts that burned EURe</span></div>${redeemOrdersTable(m.redeemOrders, true)}</section>
    <section class="card"><div class="card-h"><h2>Partner audit trail</h2></div>${auditTable(m.audit, true)}</section>`;

  const s = root.querySelector('#monSearch');
  s.addEventListener('input', () => { monQuery = s.value; renderMonerium(root); const n = root.querySelector('#monSearch'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
}

VIEWS.monerium = {
  title: 'Monerium',
  async load() { S.monerium = await api('/api/admin/monerium'); },
  render: renderMonerium,
  async click(ev, root) {
    const b = ev.target.closest('[data-mon-check]');
    if (!b) return;
    b.disabled = true;
    b.textContent = 'Asking Monerium…';
    try {
      const data = await api('/api/admin/monerium?live=1');
      S.monerium = data;
      monLive = data.app;
    } catch (err) { monLive = { ok: false, error: err.message }; }
    renderMonerium(root);
  },
};
