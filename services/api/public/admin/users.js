/* Users: the list by onboarding stage, and one account in full — its steps,
   everything Zold holds from Monerium, a live Monerium read on request, its
   transactions, recoveries, issues and audit trail. */

let userStage = 'all';
let userQuery = '';

/** A table from a list and [label, cell(row) → html] columns. */
function objTable(list, cols, emptyText = 'Nothing recorded.') {
  return `<div class="tbl-wrap"><table><thead><tr>${cols.map(([l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
    <tbody>${list.length ? list.map((r) => `<tr>${cols.map(([, f]) => `<td>${f(r) ?? '—'}</td>`).join('')}</tr>`).join('') : empty(cols.length, emptyText)}</tbody></table></div>`;
}

function stageCounts() {
  const c = { all: S.users.length };
  for (const u of S.users) { const st = u.onboarding?.stage || 'passkey'; c[st] = (c[st] || 0) + 1; }
  return c;
}

function renderUserList(root) {
  const counts = stageCounts();
  const tabs = ['all', 'passkey', 'safe', 'recovery', 'monerium', 'iban', 'active'];
  const q = userQuery.toLowerCase();
  const rows = S.users.filter((u) => {
    if (userStage !== 'all' && (u.onboarding?.stage || 'passkey') !== userStage) return false;
    if (!q) return true;
    return [u.name, u.email, u.id, u.address, u.passkeySafe?.address, u.iban, u.monerium?.profileId]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  root.innerHTML = `
    <div class="bar">
      <div class="tabs" role="group" aria-label="Filter by onboarding stage">
        ${tabs.map((t) => `<button type="button" data-stage="${t}" aria-pressed="${userStage === t}">${esc(t === 'all' ? 'All' : STAGE_LABEL[t])}<span class="c">${counts[t] || 0}</span></button>`).join('')}
      </div>
      <input type="search" id="userSearch" aria-label="Search users" placeholder="Name, email, id, Safe, IBAN, profile id" value="${esc(userQuery)}">
    </div>
    <section class="card">
      <div class="card-h"><h2>Accounts</h2><span class="sub">${rows.length} shown · ${S.users.length} total</span></div>
      <div class="tbl-wrap" style="max-height:none"><table>
        <thead><tr><th>User</th><th>Status</th><th>Monerium</th><th>IBAN</th><th>Recovery</th><th>Safe</th><th>Created</th></tr></thead>
        <tbody>${rows.length ? rows.map((u) => {
          const safe = u.passkeySafe?.address || u.address;
          const live = u.onboarding?.done?.safe;
          const m = u.monerium;
          const state = (Array.isArray(m?.profiles) ? (m.profiles.find((p) => p?.id === m.profileId) || m.profiles[0]) : null)?.state;
          return `<tr class="click" data-user="${esc(u.id)}">
            <td class="who"><b>${esc(u.name || 'Unnamed')}</b><span>${esc(u.email || u.id)}</span></td>
            <td>${stepDots(u.onboarding)}${stagePill(u.onboarding)}</td>
            <td>${m ? `${profilePill(state)}<span class="sub2">${esc(m.method || 'oauth')}</span>` : u.moneriumRefusal ? pill('bad', 'refused') : pill('dim', 'not connected')}</td>
            <td>${u.iban ? chip(u.iban) : '<span class="sub2">none</span>'}</td>
            <td>${enrolPill(u.recoveryEnrolment?.zoldenburg)}</td>
            <td>${safe && !/^0x0{40}$/.test(safe) ? chip(short(safe)) : '—'} ${live ? pill('good', 'live') : ''}</td>
            <td class="sub2">${esc(fmtWhen(u.createdAt))}</td>
          </tr>`;
        }).join('') : empty(7, 'No accounts match.')}</tbody>
      </table></div>
    </section>`;
  root.querySelectorAll('[data-stage]').forEach((b) => b.addEventListener('click', () => { userStage = b.dataset.stage; renderUserList(root); }));
  const s = root.querySelector('#userSearch');
  s.addEventListener('input', () => { userQuery = s.value; renderUserList(root); const n = root.querySelector('#userSearch'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
}

/* ---------- Monerium blocks (also used by the Monerium page) ---------- */

const orderState = (o) => o?.meta?.state || o?.state || '—';
const orderTone = (s) => (s === 'processed' ? 'good' : s === 'rejected' ? 'bad' : 'warn');

function profilesTable(list) {
  return objTable(list, [
    ['Profile', (p) => chip(p.id)],
    ['Kind', (p) => esc(p.kind || '—')],
    ['Name', (p) => esc(p.name || '—')],
    ['State', (p) => profilePill(p.state)],
    ['Other fields', (p) => esc(Object.keys(p).filter((k) => !['id', 'kind', 'name', 'state'].includes(k)).join(', ') || '—')],
  ], 'No profiles.');
}
function ibansTable(list) {
  return objTable(list, [
    ['IBAN', (i) => chip(i.iban)], ['BIC', (i) => esc(i.bic || '—')], ['Profile', (i) => chip(i.profile)],
    ['Address', (i) => chip(i.address)], ['Chain', (i) => esc(i.chain || '—')], ['State', (i) => (i.state ? pill('plain', i.state) : '—')],
  ], 'No IBANs.');
}
function addressesTable(list) {
  return objTable(list, [
    ['Address', (a) => chip(a.address)], ['Profile', (a) => chip(a.profile)],
    ['Chains', (a) => esc((a.chains || [a.chain]).filter(Boolean).join(', ') || '—')], ['State', (a) => (a.state ? pill('plain', a.state) : '—')],
  ], 'No linked addresses.');
}
function moneriumOrdersTable(list) {
  return objTable(list, [
    ['Placed', (o) => esc(fmtWhen(o.meta?.placedAt || o.placedAt))],
    ['Kind', (o) => pill(o.kind === 'issue' ? 'good' : 'plain', o.kind === 'issue' ? 'in · issue' : 'out · redeem')],
    ['Amount', (o) => `<span class="num">${esc(`${o.amount ?? '—'} ${o.currency || ''}`)}</span>`],
    ['State', (o) => pill(orderTone(orderState(o)), orderState(o))],
    ['Counterpart', (o) => `${esc(o.counterpart?.details?.name || [o.counterpart?.details?.firstName, o.counterpart?.details?.lastName].filter(Boolean).join(' ') || o.counterpart?.details?.companyName || '—')}<span class="sub2">${esc(o.counterpart?.identifier?.iban || '')}</span>`],
    ['Memo', (o) => esc(o.memo || '—')],
    ['Order', (o) => chip(o.id)],
  ], 'No orders.');
}
function issueOrdersTable(list, withUser) {
  return objTable(list, [
    ['Processed', (r) => esc(fmtWhen(r.processedAt))],
    ...(withUser ? [['User', (r) => `<a href="${href('users', r.userId)}">${esc(r.userName || r.userId)}</a>`]] : []),
    ['Amount', (r) => `<span class="num">${esc(eur(r.amountEur, 2))}</span>`],
    ['From', (r) => `${esc(r.counterpartyName || '—')}<span class="sub2">${esc(r.counterpartyIban || '')}</span>`],
    ['Reference', (r) => esc(r.memo || '—')],
    ['Order', (r) => chip(r.orderId)],
  ], 'No incoming SEPA orders recorded.');
}
function redeemOrdersTable(list, withUser) {
  return objTable(list, [
    ['Updated', (r) => esc(fmtWhen(r.updatedAt))],
    ...(withUser ? [['User', (r) => `<a href="${href('users', r.userId)}">${esc(r.userName || r.userId)}</a>`]] : []),
    ['Amount', (r) => `<span class="num">${esc(eur(r.amountEur, 2))}</span>`],
    ['To', (r) => `${esc(r.recipientName || '—')}<span class="sub2">${esc(r.recipientIban || '')}</span>`],
    ['Monerium state', (r) => (r.state ? pill(orderTone(r.state), r.state) : '—')],
    ['Transfer', (r) => `<button type="button" class="btn sm ghost" data-tx="${esc(r.transferId)}">${esc(r.transferState)}</button>`],
    ['Order', (r) => chip(r.orderId)],
    ['Detail', (r) => esc(r.error || r.detail || r.memo || '—')],
  ], 'No SEPA payouts.');
}
function auditTable(list, withUser) {
  return objTable(list, [
    ['When', (e) => esc(fmtWhen(e.at))],
    ...(withUser ? [['User', (e) => (e.userId ? `<a href="${href('users', e.userId)}">${esc(e.userName || e.userId)}</a>` : '—')]] : []),
    ['Event', (e) => pill(e.kind.includes('refused') ? 'warn' : 'plain', e.kind)],
    ['Data', (e) => `<span class="mono">${esc(JSON.stringify(e.data))}</span>`],
  ], 'No audit entries.');
}

function livePart(title, p, render) {
  if (!p) return '';
  if (!p.ok) return `<div><h3 style="font-size:13px;margin-bottom:6px">${esc(title)}</h3><div class="note bad">${esc(p.status ? `HTTP ${p.status} — ` : '')}${esc(p.error)}</div></div>`;
  return `<div><h3 style="font-size:13px;margin-bottom:6px">${esc(title)}</h3>${render(p.data)}</div>`;
}
const listOf = (d, key) => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : []);

function renderLive(live) {
  if (!live) return `<p class="sub2">Zold shows what it stored. Read live asks Monerium now, as this person (their own OAuth or API-key connection). Nothing is stored; the read is audited.</p>`;
  if (!live.available) return `<div class="note">${esc(live.reason)}</div>`;
  return `<div class="stack">
    <p class="sub2">Read from Monerium ${esc(fmtWhen(live.readAt))}. Not stored.</p>
    ${livePart('Profile (connected)', live.profile, (d) => `<div class="facts">${fact('Id', chip(d.id), true)}${fact('Kind', d.kind)}${fact('State', profilePill(d.state), true)}${fact('Name', d.name)}</div>
      <details style="margin-top:8px"><summary>Everything Monerium returned for this profile</summary><pre class="json">${esc(JSON.stringify(d, null, 2))}</pre></details>`)}
    ${livePart('All profiles on this login', live.profiles, (d) => profilesTable(listOf(d, 'profiles')))}
    ${livePart('IBANs', live.ibans, (d) => ibansTable(listOf(d, 'ibans')))}
    ${livePart('Linked addresses', live.addresses, (d) => addressesTable(listOf(d, 'addresses')))}
    ${livePart('Orders', live.orders, (d) => moneriumOrdersTable(listOf(d, 'orders')))}
    ${livePart('Auth context', live.context, (d) => `<pre class="json">${esc(JSON.stringify(d, null, 2))}</pre>`)}
  </div>`;
}

function renderUserMonerium(m, live) {
  const st = m.stored;
  const c = st.connection;
  return `
    <section class="card"><div class="card-h"><h2>Monerium</h2>
      <div class="actions"><button type="button" class="btn sm" data-live-monerium>${live ? 'Read live again' : 'Read live from Monerium'}</button>
      <button type="button" class="btn sm ghost" data-raw-monerium>Raw</button></div></div>
      <div class="card-b stack">
        <div class="facts">
          ${fact('Connection', c ? `${c.method || 'oauth'} · since ${fmtWhen(c.connectedAt)}` : 'not connected')}
          ${fact('Profile', chip(st.row.profileId), true)}
          ${fact('Profile state', profilePill(st.row.profileState), true)}
          ${fact('Funding', [st.funding?.status, st.funding?.mode].filter(Boolean).join(' · ') || '—')}
          ${fact('IBAN', chip(st.row.iban), true)}
          ${fact('BIC', st.ibanBic?.bic)}
          ${c?.apiKeys ? fact('API keys', `${c.apiKeys.clientId || ''} · ${c.apiKeys.environment || c.apiKeys.baseUrl || ''}`) : ''}
          ${c?.tokenExpiresAt ? fact('OAuth token expires', fmtWhen(c.tokenExpiresAt)) : ''}
        </div>
        ${st.funding?.detail ? `<div class="note">${esc(st.funding.detail)}</div>` : ''}
        ${st.funding?.addressUnlinkable ? '<div class="note bad">Monerium refuses to link this Safe address permanently.</div>' : ''}
        ${st.refusal ? `<div class="note warn"><b>Connect refused (${esc(st.refusal.code)})</b> ${esc(fmtWhen(st.refusal.at))} — ${esc(st.refusal.error)}</div>` : ''}
        <div><h3 style="font-size:13px;margin-bottom:6px">Live</h3><div id="moneriumLive">${renderLive(live)}</div></div>
        <details open><summary>Stored at connect: profiles (${st.profiles.length}), IBANs (${st.ibans.length}), addresses (${st.addresses.length})</summary>
          <div class="stack" style="margin-top:10px">${profilesTable(st.profiles)}${ibansTable(st.ibans)}${addressesTable(st.addresses)}</div></details>
        ${st.ibanMoves.length ? `<details open><summary>IBAN moves (${st.ibanMoves.length})</summary>${objTable(st.ibanMoves, [
          ['Requested', (x) => esc(fmtWhen(x.requestedAt))], ['IBAN', (x) => chip(x.iban)],
          ['From', (x) => `${chip(x.fromAddress)} <span class="sub2">${esc(x.fromChain)}</span>`],
          ['To', (x) => `${chip(x.toAddress)} <span class="sub2">${esc(x.toChain)}</span>`],
          ['Confirmed', (x) => (x.confirmedAt ? pill('good', fmtWhen(x.confirmedAt)) : pill('warn', 'not seen yet'))],
        ])}</details>` : ''}
        <details open><summary>Incoming SEPA (issue orders) — ${st.issueOrders.length}</summary>${issueOrdersTable(st.issueOrders)}</details>
        <details open><summary>Outgoing SEPA (redeem orders) — ${st.redeemOrders.length}</summary>${redeemOrdersTable(st.redeemOrders)}</details>
        <details><summary>Monerium audit trail — ${st.audit.length}</summary>${auditTable(st.audit)}</details>
      </div>
    </section>`;
}

/* ---------- one user ---------- */

async function loadUserDetail(id, live) {
  const c = S.userCache[id] || (S.userCache[id] = {});
  const [detail, mon] = await Promise.all([
    api(`/api/admin/users/${encodeURIComponent(id)}`),
    api(`/api/admin/users/${encodeURIComponent(id)}/monerium${live ? '?live=1' : ''}`),
  ]);
  c.detail = detail;
  c.monerium = mon;
  if (live) c.live = mon.live;
}

function renderUserDetail(root, id) {
  const c = S.userCache[id];
  if (!c?.detail) { root.innerHTML = '<div class="note">Loading…</div>'; return; }
  const { user: u, transactions, recoveries, memberships, issues, audit } = c.detail;
  const onb = u.onboarding;
  const curIdx = onb.stage === 'active' ? -1 : STEPS.indexOf(onb.stage);
  const safe = u.passkeySafe?.address || u.address;
  const r = u.recoveryEnrolment || {};
  root.innerHTML = `
    <a class="back" href="#/users">← All users</a>
    <section class="card"><div class="card-h">
        <div><h2 style="font-size:18px">${esc(u.name || 'Unnamed')}</h2><span class="sub">${esc(u.email || '')} · ${chip(u.id)}</span></div>
        <div class="actions">${stagePill(onb)} ${kycPill(u.kycStatus)} <button type="button" class="btn sm ghost" data-raw-user>Raw</button></div></div>
      <div class="card-b stack">
        <div class="stepper">${STEPS.map((s, i) => `<div class="${onb.done[s] ? 'on' : i === curIdx ? 'cur' : ''}">${onb.done[s] ? '✓ ' : i === curIdx ? '→ ' : ''}${esc(STEP_LABEL[s])}</div>`).join('')}</div>
        <div class="facts">
          ${fact('Country', u.country)}
          ${fact('Created', fmtWhen(u.createdAt))}
          ${fact('Safe', `${chip(safe)} ${onb.done.safe ? pill('good', 'live') : pill('dim', u.passkeySafe?.status || 'not deployed')}`, true)}
          ${fact('Passkey', u.passkey ? `${u.passkey.rpId} · ${fmtWhen(u.passkey.createdAt)}` : '—')}
          ${fact('Recovery', `${enrolPill(r.zoldenburg)}${r.chosenAt ? ` <span class="sub2">${esc(fmtWhen(r.chosenAt))}</span>` : ''}`, true)}
          ${r.candide ? fact('Email/SMS recovery', `${r.candide.status} · ${r.candide.channels.join(', ')}`) : ''}
          ${fact('Segment', u.segment?.value)}
          ${fact('Organisations', memberships.map((m) => `${m.org || m.orgId} (${m.role})`).join(', ') || '—')}
        </div>
      </div></section>

    ${issues.length ? `<section class="card"><div class="card-h"><h2>Open issues</h2></div><div class="issues">${issues.map(issueRow).join('')}</div></section>` : ''}

    ${c.monerium ? renderUserMonerium(c.monerium, c.live) : ''}

    <section class="card"><div class="card-h"><h2>Transactions</h2><span class="sub">${transactions.length}</span></div>
      ${objTable(transactions, [
        ['Updated', (t) => esc(fmtWhen(t.updatedAt))], ['Kind', (t) => esc(railLabel(t))],
        ['Amount', (t) => `<span class="num">${esc(amountLabel(t))}</span>`], ['State', (t) => txPill(t)],
        ['Detail', (t) => esc(t.statusDetail || t.error || '—')],
        ['', (t) => `<button type="button" class="btn sm ghost" data-tx="${esc(t.id)}">Open</button>`],
      ], 'No transactions.')}</section>

    <section class="card"><div class="card-h"><h2>Recovery requests</h2></div>
      ${objTable(recoveries, [
        ['Requested', (x) => esc(fmtWhen(x.requestedAt))], ['Mode', (x) => esc(x.mode || '—')],
        ['Reference', (x) => chip(x.reference)], ['Status', (x) => rvPillFor(x.status)],
        ['', (x) => (x.mode === 'zoldenburg' ? `<a href="${href('recoveries', x.id)}">Open</a>` : '')],
      ], 'None.')}</section>

    <section class="card"><div class="card-h"><h2>Audit trail</h2></div>${auditTable(audit)}</section>`;
}

/* Status pill for a recovery request (recoveries.js holds the full map). */
function rvPillFor(status) {
  const map = {
    PASSKEY_PENDING: ['dim', 'No passkey yet'], REVIEW_PENDING: ['warn', 'Needs review'], GRACE_PERIOD: ['warn', 'Waiting period'],
    FINALIZED: ['good', 'Recovered'], CANCELED: ['dim', 'Cancelled'], EXPIRED: ['dim', 'Expired'],
  };
  const [tone, label] = map[status] || ['dim', status];
  return pill(tone, label);
}

VIEWS.users = {
  title: 'Users',
  async load(arg) {
    if (arg && !arg.startsWith('stage:')) await loadUserDetail(arg);
    else await loadUsers();
  },
  render(root, arg) {
    if (arg && arg.startsWith('stage:')) { userStage = arg.slice(6); renderUserList(root); return; }
    if (arg) { renderUserDetail(root, arg); return; }
    renderUserList(root);
  },
  /** Live Monerium reads and raw views, delegated on the view root. */
  async click(ev, root, arg) {
    const c = S.userCache[arg];
    if (ev.target.closest('[data-raw-user]') && c) return openModal(`User ${arg}`, c.detail.user);
    if (ev.target.closest('[data-raw-monerium]') && c) return openModal(`Monerium · ${arg}`, { ...c.monerium, live: c.live });
    const btn = ev.target.closest('[data-live-monerium]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Asking Monerium…';
      try { await loadUserDetail(arg, true); renderUserDetail(root, arg); }
      catch (err) { document.getElementById('moneriumLive').innerHTML = `<div class="note bad">${esc(err.message)}</div>`; btn.disabled = false; }
    }
  },
};
