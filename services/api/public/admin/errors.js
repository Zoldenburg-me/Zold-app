/* Errors: every open problem from every place one is recorded (server 500s
   by reference, failed and stuck transfers, refused deposits, Monerium
   refusals and provisioning errors, recoveries that would not finalize,
   partner calls refused by policy), plus the server-error stacks. Server
   errors live in the API's memory, so a restart empties that part. */

let errSource = 'all';
let errQuery = '';

const SOURCE_LABEL = {
  all: 'All', server: 'Server', transfer: 'Transfers', deposit: 'Deposits', monerium: 'Monerium', recovery: 'Recovery', policy: 'Policy',
};

function renderErrors(root, ref) {
  const q = errQuery.trim().toLowerCase();
  const list = S.issues.filter((i) => (errSource === 'all' || i.source === errSource)
    && (!q || [i.title, i.detail, i.userName, i.userId, i.target?.id].filter(Boolean).join(' ').toLowerCase().includes(q)));
  const count = (k) => (k === 'all' ? S.issues.length : S.issues.filter((i) => i.source === k).length);
  const errs = S.issues.filter((i) => i.severity === 'error').length;
  const day = S.issues.filter((i) => Date.now() - Date.parse(i.at) < 86_400_000).length;
  const refQ = (ref || errQuery).trim().toUpperCase();
  const server = refQ.startsWith('E-') ? S.serverErrors.filter((e) => e.ref.includes(refQ)) : S.serverErrors;

  root.innerHTML = `
    <div class="kpis">
      <div class="card kpi ${errs ? 'bad' : 'good'}"><span class="k">Errors</span><span class="v">${errs}</span><span class="s">severity error</span></div>
      <div class="card kpi ${S.issues.length - errs ? 'warn' : ''}"><span class="k">Warnings</span><span class="v">${S.issues.length - errs}</span><span class="s">stuck, refunded, refused</span></div>
      <div class="card kpi"><span class="k">Last 24 hours</span><span class="v">${day}</span><span class="s">new or updated</span></div>
      <div class="card kpi"><span class="k">Server 500s</span><span class="v">${S.serverErrors.length}</span><span class="s">since the API last started</span></div>
    </div>
    <div class="bar">
      <div class="tabs" role="group" aria-label="Filter issues by source">
        ${Object.keys(SOURCE_LABEL).map((k) => `<button type="button" data-errsrc="${k}" aria-pressed="${errSource === k}">${esc(SOURCE_LABEL[k])}<span class="c">${count(k)}</span></button>`).join('')}
      </div>
      <input type="search" id="errSearch" aria-label="Search issues or an E- reference" placeholder="Search, or an E-… reference a user quoted" value="${esc(errQuery || ref || '')}">
    </div>
    <section class="card"><div class="card-h"><h2>Issues</h2><span class="sub">${list.length} shown</span></div>
      <div class="issues">${list.length ? list.map(issueRow).join('') : '<div class="issue"><div></div><div class="d">Nothing matches.</div></div>'}</div></section>
    <section class="card" id="serverErrors"><div class="card-h"><h2>Server errors by reference</h2><span class="sub">in memory · newest first</span></div>
      ${objTable(server, [
        ['Reference', (e) => chip(e.ref)],
        ['When', (e) => `${esc(fmtWhen(e.at))}<span class="sub2">${esc(fmtAgo(e.at))}</span>`],
        ['Route', (e) => `<span class="mono">${esc(`${e.status} ${e.method} ${e.route}`)}</span>`],
        ['Error', (e) => `<details ${server.length === 1 ? 'open' : ''}><summary>${esc(`${e.name}: ${e.message}`)}</summary><pre class="json" style="margin-top:8px">${esc(e.stack.join('\n'))}</pre></details>`],
      ], refQ.startsWith('E-') ? 'No error with that reference since the API last started.' : 'No server errors since the API last started.')}</section>`;

  root.querySelectorAll('[data-errsrc]').forEach((b) => b.addEventListener('click', () => { errSource = b.dataset.errsrc; renderErrors(root); }));
  const s = root.querySelector('#errSearch');
  s.addEventListener('input', () => { errQuery = s.value; renderErrors(root); const n = root.querySelector('#errSearch'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
  if (ref && !errQuery) document.getElementById('serverErrors').scrollIntoView({ block: 'start' });
}

VIEWS.errors = {
  title: 'Errors',
  async load() { await loadIssues(); },
  render: renderErrors,
};
