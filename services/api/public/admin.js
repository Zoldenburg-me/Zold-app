/**
 * The operator dashboard.
 *
 * Read only, with ONE exception: Recoveries, where an operator reviews a
 * person who lost their passkey and signs as Zoldenburg's guardian from the
 * Keycard Shell (through MetaMask/Rabby, or Safe Cover). KYC review and IBAN issue belong to Monerium.
 *
 * Two security details. The operator token lives in sessionStorage so it does
 * not outlive the tab. Rows carry ids for a delegated listener; don't build an
 * inline onclick from row data, since a signup name containing a quote can
 * close the JS string (stored XSS next to that token).
 */
let allUsers = [];
let allTransactions = [];
let stats = {};
let currentFilter = 'all';
let currentTxFilter = 'all';

/* A transfer still moving through its state machine. Terminal or
   already-flagged states are excluded; everything else that has not been
   touched for STALE_MS is probably stuck, and stuck money is the thing an
   operator exists to notice. */
const ATTENTION_STATES = ['FAILED', 'REFUNDED', 'REFUSED', 'MANUAL_REVIEW'];
const TERMINAL_STATES = ['PAID', 'CONVERTED', ...ATTENTION_STATES];
const STALE_MS = 30 * 60_000;
const isInflight = (t) => t.kind !== 'funding' && !TERMINAL_STATES.includes(t.state);
const isStale = (t) => {
  const updated = Date.parse(t.updatedAt || t.createdAt || t.detectedAt || '') || 0;
  return isInflight(t) && Date.now() - updated > STALE_MS;
};

const tokenInput = document.getElementById('operatorToken');
const authPill = document.getElementById('authPill');
const authText = document.getElementById('authText');
const searchInput = document.getElementById('searchInput');

// The operator token is kept for this tab only: it is the remote
// approval switch for every account, and any same-origin script can read
// localStorage.
// Debounced: a request per keystroke would fire a burst of 401s for every
// prefix of the token.
let tokenTimer;
tokenInput.addEventListener('input', () => {
  sessionStorage.setItem('zold_operator_token', tokenInput.value);
  clearTimeout(tokenTimer);
  tokenTimer = setTimeout(loadDashboard, 400);
});
localStorage.removeItem('zold_operator_token');

if (sessionStorage.getItem('zold_operator_token')) {
  tokenInput.value = sessionStorage.getItem('zold_operator_token');
}

async function fetchApi(path, options = {}) {
  const token = tokenInput.value.trim();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {})
  };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    authPill.className = 'auth-status offline';
    authText.textContent = 'Unauthorized';
    // Stale rows under a dead token read as live ops data. Drop them.
    if (allUsers.length || allTransactions.length) {
      allUsers = [];
      allTransactions = [];
      stats = {};
      renderUsers();
      renderTransactions();
      renderAttention();
    }
  } else {
    authPill.className = 'auth-status online';
    authText.textContent = 'Connected';
  }
  return res;
}

async function loadDashboard() {
  try {
    const statsRes = await fetchApi('/api/admin/stats');
    if (statsRes.ok) {
      stats = await statsRes.json();
      document.getElementById('statUsers').textContent = stats.totalUsers ?? 0;
      document.getElementById('statPending').textContent = stats.kycPending ?? 0;
      document.getElementById('statSafes').textContent = stats.activeSafes ?? 0;
      document.getElementById('statTransfers').textContent = stats.totalTransfers ?? 0;
      document.getElementById('statVolume').textContent =
        `Volume €${Number(stats.totalVolumeEur ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      renderFloat();
    }

    const usersRes = await fetchApi('/api/admin/users');
    if (usersRes.ok) {
      allUsers = await usersRes.json();
    }

    const txRes = await fetchApi('/api/admin/transactions?limit=300');
    if (txRes.ok) {
      const data = await txRes.json();
      allTransactions = data.transactions || [];
    }
    renderUsers();
    renderTransactions();
    renderAttention();
    await loadRecoveries();
  } catch (err) {
    console.error("Dashboard error:", err);
  }
}

/* ---------- Recoveries (Zoldenburg guardian) ---------- */

let recoveries = { enabled: false, requests: [] };
let openRecoveryId = null;
const RV_STATUS = {
  PASSKEY_PENDING: ['badge-neutral', 'No passkey yet'],
  REVIEW_PENDING: ['badge-review', 'Needs review'],
  GRACE_PERIOD: ['badge-pending', 'Waiting period'],
  FINALIZED: ['badge-approved', 'Recovered'],
  CANCELED: ['badge-neutral', 'Cancelled'],
  EXPIRED: ['badge-neutral', 'Expired'],
};

async function loadRecoveries() {
  const res = await fetchApi('/api/admin/recoveries');
  if (!res.ok) return;
  recoveries = await res.json();
  renderRecoveries();
}

function renderRecoveries() {
  const body = document.getElementById('recoveriesTableBody');
  const rows = recoveries.requests || [];
  document.getElementById('recoveriesCount').textContent = rows.filter((r) => r.status === 'REVIEW_PENDING').length || '';
  document.getElementById('recoveriesGuardian').textContent = recoveries.enabled
    ? `Guardian ${recoveries.guardianAddress} · chain ${recoveries.chainId}`
    : 'Not configured — CANDIDE_RECOVERY_GUARDIAN_ADDRESS is unset';
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted);">No recovery requests.</td></tr>`;
  } else {
    body.innerHTML = rows.map((r) => {
      const [cls, label] = RV_STATUS[r.status] || ['badge-neutral', r.status];
      const a = r.account || {};
      return `<tr>
        <td><span class="code-pill" translate="no">${escapeHtml(r.zoldenburg?.reference || '—')}</span></td>
        <td><div class="user-info"><span class="user-name">${escapeHtml(a.name || '—')}</span><span class="user-id">${escapeHtml(a.email || a.id || '')}</span></div></td>
        <td><span class="badge ${a.kycStatus === 'approved' ? 'badge-approved' : 'badge-pending'}">${escapeHtml(a.kycStatus || 'unknown')}</span></td>
        <td><span class="badge ${cls}">${escapeHtml(label)}</span></td>
        <td>${escapeHtml(fmtWhen(r.requestedAt))}</td>
        <td><button type="button" class="btn btn-iban" data-open-recovery="${escapeHtml(r.id)}" aria-expanded="${openRecoveryId === r.id}">${r.status === 'REVIEW_PENDING' ? 'Review' : 'Open'}</button></td>
      </tr>`;
    }).join('');
  }
  // Re-render the open detail only if its data changed underneath it and the
  // operator is not typing in it.
  const det = document.getElementById('recoveryDetail');
  if (openRecoveryId && !det.contains(document.activeElement)) renderRecoveryDetail();
}

function rvField(k, v, mono) {
  return `<div><div class="rv-k">${escapeHtml(k)}</div><div class="rv-v${mono ? ' mono' : ''}" ${mono ? 'translate="no"' : ''}>${escapeHtml(v ?? '—')}</div></div>`;
}

function renderRecoveryDetail(message) {
  const det = document.getElementById('recoveryDetail');
  const r = (recoveries.requests || []).find((x) => x.id === openRecoveryId);
  if (!r) { det.hidden = true; det.innerHTML = ''; return; }
  const a = r.account || {};
  const z = r.zoldenburg || {};
  const review = r.status === 'REVIEW_PENDING';
  const grace = r.status === 'GRACE_PERIOD';
  const ready = grace && z.finalizeAfter && Date.now() >= Date.parse(z.finalizeAfter);
  det.hidden = false;
  det.innerHTML = `
    <div class="rv-grid">
      ${rvField('Reference', z.reference, true)}
      ${rvField('Name', a.name)}
      ${rvField('Email', a.email)}
      ${rvField('Country', a.country)}
      ${rvField('Monerium KYC', a.kycStatus)}
      ${rvField('Monerium link', a.moneriumMethod ? `${a.moneriumMethod}${a.moneriumProfileId ? ' · profile ' + a.moneriumProfileId : ''}` : 'not connected')}
      ${rvField('IBAN', a.iban)}
      ${rvField('Account created', a.createdAt ? fmtWhen(a.createdAt) : '—')}
      ${rvField('Safe', r.safeAddress, true)}
      ${rvField('New owner (new passkey)', (z.newOwners || []).join(', '), true)}
      ${rvField('Requested', fmtWhen(r.requestedAt))}
      ${rvField(grace ? 'Finalizable after' : 'Expires', grace ? fmtWhen(z.finalizeAfter) : fmtWhen(r.expiresAt))}
      ${z.executeTxHash ? rvField('Execute tx', z.executeTxHash, true) : ''}
      ${z.finalizeTxHash ? rvField('Finalize tx', z.finalizeTxHash, true) : ''}
      ${r.reviewReason ? rvField('Review note', r.reviewReason) : ''}
      ${r.cancelReason ? rvField('Cancel reason', r.cancelReason) : ''}
      ${z.finalizeError ? rvField('Last finalize error', z.finalizeError) : ''}
    </div>
    ${review ? `
      <div class="rv-box warn">
        <b>Before you sign.</b> Signing starts a takeover of this account: after the waiting period the new passkey owns it. Only the old passkey can stop it.
        <ol>
          <li>The person wrote from <b>${escapeHtml(a.email || 'the account email')}</b> and quoted reference <b translate="no">${escapeHtml(z.reference || '')}</b>.</li>
          <li>You checked them against the identity Monerium verified (${a.kycStatus === 'approved' ? 'approved' : '<b>NOT approved</b>'}) — Zold holds the result, not the documents.</li>
          <li>Anything unusual (new email, urgency, a third party speaking for them) → reject.</li>
        </ol>
      </div>
      <div>
        <label for="rvNote">How you verified the person (stored with the request)</label>
        <textarea id="rvNote" rows="2" placeholder="e.g. Video call 29 Sep, matched name and DOB with Monerium profile, email from account address" autocomplete="off"></textarea>
      </div>
      <div class="rv-actions">
        ${r.safeCoverLink
          ? `<a class="btn btn-link" href="${escapeHtml(r.safeCoverLink)}" target="_blank" rel="noopener noreferrer">Open in Safe Cover ↗</a>
             <button type="button" class="btn btn-iban" data-rv="sync">I signed in Safe Cover — check chain</button>`
          : `<span class="rv-k">Safe Cover does not list chain ${escapeHtml(recoveries.chainId)} — sign here</span>`}
        <button type="button" class="btn btn-approve" data-rv="sign">Sign with Keycard Shell</button>
      </div>
      <details>
        <summary>Signed on another device? Paste the signature</summary>
        <div class="rv-actions" style="margin-bottom:10px"><button type="button" class="btn btn-icon" data-rv="payload">Show typed data to sign</button></div>
        <pre class="json-code" id="rvPayload" hidden></pre>
        <label for="rvSig" style="margin-top:10px">eth_signTypedData_v4 signature (0x…, 65 bytes)</label>
        <textarea id="rvSig" class="mono" rows="2" autocomplete="off" spellcheck="false"></textarea>
        <div class="rv-actions" style="margin-top:10px"><button type="button" class="btn btn-approve" data-rv="execute">Relay signature</button></div>
      </details>
      <div>
        <label for="rvReason">Reject — reason the person will see</label>
        <input type="text" id="rvReason" autocomplete="off" placeholder="e.g. We could not verify your identity. Contact support@zoldhq.com.">
        <div class="rv-actions" style="margin-top:10px"><button type="button" class="btn btn-reject" data-rv="reject">Reject request</button></div>
      </div>` : ''}
    ${grace ? `
      <div class="rv-box">The recovery is on chain. The owner's old passkey can cancel it until <b>${escapeHtml(fmtWhen(z.finalizeAfter))}</b>; after that the sweep finalizes it and binds the new passkey.</div>
      <div class="rv-actions"><button type="button" class="btn btn-approve" data-rv="finalize" ${ready ? '' : 'disabled'}>Finalize now</button></div>` : ''}
    <div id="rvMsg" role="status" aria-live="polite">${message || ''}</div>`;
}

async function recoveryAction(path, body) {
  const res = await fetchApi(`/api/admin/recoveries/${encodeURIComponent(openRecoveryId)}/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function rvMessage(text, ok) {
  const el = document.getElementById('rvMsg');
  if (el) el.innerHTML = `<span class="${ok ? 'rv-ok' : 'rv-err'}">${escapeHtml(text)}</span>`;
}

async function afterRecoveryAction(updated, text) {
  await loadRecoveries();
  renderRecoveryDetail(`<span class="rv-ok">${escapeHtml(text)}</span>`);
  if (updated?.status) document.getElementById('recoveryDetail').focus?.();
}

/* The guardian is a Keycard Shell: air-gapped, QR only. MetaMask or Rabby
   holds it as a QR hardware account; eth_signTypedData_v4 shows a QR, the
   Shell scans it, clear-signs the EIP-712 fields on its own screen, and its
   answer QR is scanned back. The API checks the signer and the digest; this
   only asks. */
async function walletSign(guardianAddress, typedData) {
  if (!window.ethereum) throw new Error('No browser wallet found. Add the Keycard Shell to MetaMask or Rabby as a QR hardware wallet, then reload.');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const account = (accounts || []).find((x) => x.toLowerCase() === guardianAddress.toLowerCase());
  if (!account) throw new Error(`Select the guardian account ${guardianAddress} (the Keycard Shell account) in your wallet — it offered ${(accounts || []).join(', ') || 'none'}.`);
  return window.ethereum.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typedData)] });
}

/* What the Shell's screen must show, field by field. Anything else: reject on
   the device. */
function deviceChecklist(req) {
  const d = req.typedData.domain, m = req.typedData.message;
  const line = (k, v) => `<li><span class="rv-k">${escapeHtml(k)}</span> <span class="rv-v mono" translate="no">${escapeHtml(v)}</span></li>`;
  return `<div class="rv-box warn" style="margin-top:10px"><b>Scan the QR with Keycard Shell and check its screen shows exactly:</b>
    <ul style="list-style:none;margin-top:8px;display:grid;gap:4px">
      ${line('Domain', `${d.name} ${d.version}`)}
      ${line('Chain', d.chainId)}
      ${line('Contract', d.verifyingContract)}
      ${line('wallet (the Safe)', m.wallet)}
      ${line('newOwners', m.newOwners.join(', '))}
      ${line('newThreshold', m.newThreshold)}
      ${line('nonce', m.nonce)}
    </ul>Approve on the Shell, then scan its answer QR back into the wallet.</div>`;
}

async function signWithWallet() {
  const note = document.getElementById('rvNote').value.trim();
  if (note.length < 10) return rvMessage('Record how you verified the person first.');
  rvMessage('Preparing the recovery…', true);
  const req = await recoveryAction('sign-request');
  document.getElementById('rvMsg').innerHTML = deviceChecklist(req);
  const signature = await walletSign(req.guardianAddress, req.typedData);
  rvMessage('Relaying and waiting for the chain…', true);
  const updated = await recoveryAction('execute', { signature, reviewNote: note });
  await afterRecoveryAction(updated, 'Signed and executed. The waiting period has started.');
}

document.getElementById('rvCheckBtn').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const out = document.getElementById('rvCheckMsg');
  const say = (text, ok) => { out.innerHTML = `<p class="${ok ? 'rv-ok' : 'rv-err'}" style="padding:10px 0">${escapeHtml(text)}</p>`; };
  btn.disabled = true;
  try {
    const cRes = await fetchApi('/api/admin/recoveries/guardian-check/challenge', { method: 'POST', body: '{}' });
    const c = await cRes.json();
    if (!cRes.ok) throw new Error(c.error || `HTTP ${cRes.status}`);
    say('Sign the test message on the Keycard Shell. It approves nothing and touches no Safe.', true);
    const signature = await walletSign(c.guardianAddress, c.typedData);
    const vRes = await fetchApi('/api/admin/recoveries/guardian-check', { method: 'POST', body: JSON.stringify({ issuedAt: c.typedData.message.issuedAt, signature }) });
    const v = await vRes.json();
    if (!vRes.ok) throw new Error(v.error || `HTTP ${vRes.status}`);
    say(`Guardian wallet works: the signature recovers to ${v.guardianAddress}.`, true);
  } catch (err) {
    say(err?.message || String(err));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('recoveriesPanel').addEventListener('click', async (ev) => {
  const open = ev.target.closest('[data-open-recovery]');
  if (open) {
    openRecoveryId = openRecoveryId === open.dataset.openRecovery ? null : open.dataset.openRecovery;
    renderRecoveries();
    renderRecoveryDetail();
    return;
  }
  const act = ev.target.closest('[data-rv]');
  if (!act || !openRecoveryId) return;
  act.disabled = true;
  try {
    const kind = act.dataset.rv;
    if (kind === 'sign') await signWithWallet();
    else if (kind === 'payload') {
      const req = await recoveryAction('sign-request');
      const pre = document.getElementById('rvPayload');
      pre.hidden = false;
      pre.textContent = `Guardian: ${req.guardianAddress}\nDigest:   ${req.digest}\n\n${JSON.stringify(req.typedData, null, 2)}`;
    } else if (kind === 'execute') {
      const note = document.getElementById('rvNote').value.trim();
      if (note.length < 10) { rvMessage('Record how you verified the person first.'); return; }
      rvMessage('Relaying and waiting for the chain…', true);
      const updated = await recoveryAction('execute', { signature: document.getElementById('rvSig').value.trim(), reviewNote: note });
      await afterRecoveryAction(updated, 'Signed and executed. The waiting period has started.');
    } else if (kind === 'sync') {
      const updated = await recoveryAction('sync', { reviewNote: document.getElementById('rvNote').value.trim() });
      if (updated.status === 'REVIEW_PENDING') rvMessage('The chain shows no recovery for this Safe yet. Finish confirm + execute in Safe Cover, then check again.');
      else await afterRecoveryAction(updated, 'Seen on chain. The waiting period has started.');
    } else if (kind === 'reject') {
      const reason = document.getElementById('rvReason').value.trim();
      if (!reason) { rvMessage('Give a reason — the person sees it.'); return; }
      if (!confirm('Reject this recovery request?')) return;
      const updated = await recoveryAction('reject', { reason });
      await afterRecoveryAction(updated, 'Rejected.');
    } else if (kind === 'finalize') {
      const updated = await recoveryAction('finalize');
      await afterRecoveryAction(updated, updated.status === 'FINALIZED' ? 'Finalized. The new passkey owns the account.' : 'Not finalized yet — see the error above.');
    }
  } catch (err) {
    rvMessage(err?.message || String(err));
  } finally {
    if (act.isConnected) act.disabled = false;
  }
});

/* The deployer pays gas. Its balance dropping below
   a couple of grants is an outage-in-waiting that otherwise only shows as
   a console warning nobody reads. */
function floatLow() {
  const d = stats.deployer;
  if (!d) return false;
  return d.eth < 0.002;
}

function renderFloat() {
  const d = stats.deployer;
  const el = document.getElementById('statFloat');
  const sub = document.getElementById('statFloatSub');
  if (!d) { el.textContent = '—'; sub.textContent = 'unreadable'; return; }
  el.textContent = `€${Number(d.eur).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  el.style.color = floatLow() ? 'var(--danger)' : 'var(--text)';
  const gasParts = (stats.operatorGas || []).map(w => `${w.role.split(' ')[0]} ${Number(w.eth).toFixed(3)}`);
  sub.textContent = gasParts.length
    ? `ETH: ${gasParts.join(' · ')}`
    : `${Number(d.eth).toFixed(4)} ETH gas`;
}

/* ---------- triage strip ---------- */

/* An operator wallet without gas is a rail-specific outage whose error
   message will not name the wallet — this row does. */
const GAS_FLOOR_ETH = 0.001;

function attentionItems() {
  const items = [];
  for (const w of (stats.operatorGas || [])) {
    if (w.eth < GAS_FLOOR_ETH) {
      items.push({
        kind: 'float', label: 'GAS', who: w.role,
        why: `${w.address} holds ${w.eth.toFixed(5)} ETH — its transactions fail with "gas required exceeds allowance (0)" until topped up`,
        actions: '',
      });
    }
  }
  if (floatLow()) {
    const d = stats.deployer;
    items.push({
      kind: 'float', label: 'FLOAT', who: 'Deployer wallet',
      why: `€${Number(d.eur).toFixed(0)} EURe / ${Number(d.eth).toFixed(4)} ETH left — top it up before gas starts failing`,
      actions: '',
    });
  }
  // Identity is Monerium's: nothing here approves, rejects or issues. The
  // rows name where each account is stuck so support can help it along.
  for (const u of allUsers) {
    if (u.kycStatus === 'pending' || u.kycStatus === 'manual_review') {
      items.push({
        kind: 'kyc', label: 'Monerium', who: u.name || u.id, why: `${u.kycStatus.replace('_', ' ')} since ${fmtWhen(u.createdAt)} — activates with a passkey once Monerium attributes an IBAN`,
        actions: inspectUserBtn(u),
      });
    } else if (u.kycStatus === 'approved' && !u.iban) {
      items.push({
        kind: 'iban', label: 'IBAN', who: u.name || u.id,
        why: (u.passkeySafe?.status === 'active' || u.wallet?.deployed)
          ? 'approved, Safe deployed, no IBAN yet — Monerium issues it; the user activates with a passkey tap'
          : 'approved but smart wallet not finished — user must complete onboarding first',
        actions: inspectUserBtn(u),
      });
    }
  }
  for (const t of allTransactions) {
    if (ATTENTION_STATES.includes(t.state)) {
      items.push({
        kind: 'tx', label: t.state, who: t.user?.name || t.user?.id || 'unknown',
        why: `${railLabel(t)} · ${amountLabel(t)} · ${t.statusDetail || t.error || ''}`,
        actions: inspectTxBtn(t),
      });
    } else if (isStale(t)) {
      items.push({
        kind: 'stale', label: 'STUCK', who: t.user?.name || t.user?.id || 'unknown',
        why: `${railLabel(t)} · ${amountLabel(t)} · in ${t.state} since ${fmtWhen(t.updatedAt || t.createdAt)}`,
        actions: inspectTxBtn(t),
      });
    }
  }
  return items;
}

/* Icon-only buttons: the emoji is decoration, the label names the target. */
function inspectUserBtn(u) {
  const label = `Inspect user ${u.name || u.id}`;
  return `<button type="button" class="btn-icon" data-inspect-user="${escapeHtml(u.id)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><span aria-hidden="true">🔍</span></button>`;
}

function inspectTxBtn(t, icon = '🔍') {
  const label = `Inspect transfer ${t.id}`;
  return `<button type="button" class="btn-icon" data-inspect-tx="${escapeHtml(t.id)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><span aria-hidden="true">${icon}</span></button>`;
}

function renderAttention() {
  const items = attentionItems();
  const card = document.getElementById('attentionCard');
  const list = document.getElementById('attentionList');
  document.getElementById('attentionCount').textContent = items.length;
  document.getElementById('statAttention').textContent = items.length;
  document.getElementById('statAttention').style.color = items.length ? 'var(--warning)' : 'var(--success)';
  card.classList.toggle('calm', items.length === 0);
  list.innerHTML = items.length
    ? items.map(i => `
        <div class="attention-row">
          <span class="attention-kind ${i.kind}">${escapeHtml(i.label)}</span>
          <span class="who">${escapeHtml(i.who)}</span>
          <span class="why">${escapeHtml(i.why)}</span>
          <span class="actions-cell">${i.actions}</span>
        </div>`).join('')
    : `<div class="attention-row" style="color:var(--text-dim)">Nothing waiting on you. Queues are clear.</div>`;
}

/* ---------- panels ---------- */

function jumpToUsers(filter) {
  setFilter('userFilterTabs', 'filter', filter);
  currentFilter = filter;
  renderUsers();
  document.getElementById('usersPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function jumpToTx(filter) {
  setFilter('txFilterTabs', 'txFilter', filter);
  currentTxFilter = filter;
  renderTransactions();
  document.getElementById('txPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setFilter(groupId, dataKey, value) {
  document.querySelectorAll(`#${groupId} .tab-btn`).forEach(b => {
    const on = b.dataset[dataKey] === value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function renderUsers() {
  const tbody = document.getElementById('usersTableBody');
  const query = searchInput.value.toLowerCase();

  const filtered = allUsers.filter(u => {
    const matchesFilter =
      currentFilter === 'all' ? true :
      currentFilter === 'no-iban' ? (u.kycStatus === 'approved' && !u.iban) :
      u.kycStatus === currentFilter;
    const matchesSearch = !query ||
      (u.name && u.name.toLowerCase().includes(query)) ||
      (u.id && u.id.toLowerCase().includes(query)) ||
      (u.address && u.address.toLowerCase().includes(query)) ||
      (u.iban && u.iban.toLowerCase().includes(query));
    return matchesFilter && matchesSearch;
  });

  document.getElementById('usersCount').textContent = `${filtered.length} shown · ${allUsers.length} total`;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);">No accounts match the criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(u => {
    const safeAddr = u.passkeySafe?.address || u.address || '';
    const shortAddr = safeAddr && safeAddr !== '0x0000000000000000000000000000000000000000'
      ? safeAddr.substring(0, 6) + '...' + safeAddr.substring(safeAddr.length - 4)
      : 'Not Deployed';

    const safeDeployed = u.wallet?.deployed || u.passkeySafe?.status === 'active';

    const kycBadgeClass = u.kycStatus === 'approved' ? 'badge-approved' :
                         (u.kycStatus === 'pending' || u.kycStatus === 'manual_review') ? 'badge-pending' : 'badge-rejected';

    const balance = typeof u.safeBalanceEur === 'number' || typeof u.balanceEur === 'number'
      ? `€${Number(u.safeBalanceEur ?? u.balanceEur).toFixed(2)}`
      : '—';

    return `
      <tr>
        <td>
          <div class="user-info">
            <span class="user-name">${escapeHtml(u.name || 'Anonymous')}</span>
            <span class="user-id">${escapeHtml(u.id)}</span>
          </div>
        </td>
        <td><strong>${escapeHtml(u.country || '—')}</strong></td>
        <td><span class="badge ${kycBadgeClass}">${escapeHtml(u.kycStatus)}</span></td>
        <td>
          <span class="code-pill">${escapeHtml(shortAddr)}</span>
          ${safeDeployed ? '<span class="badge badge-approved" style="font-size: 10px; padding: 2px 6px;">Live</span>' : ''}
        </td>
        <td>
          ${u.iban ? `<span class="code-pill" style="color: var(--success);">${escapeHtml(u.iban)}</span>` : '<span style="color: var(--text-dim);">No IBAN</span>'}
        </td>
        <td style="font-weight:600">${balance}</td>
        <td style="color: var(--text-muted); font-size: 12px;">${new Date(u.createdAt).toLocaleDateString()}</td>
        <td>
          <div class="actions-cell">
            ${inspectUserBtn(u)}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function statusBadgeClass(state) {
  if (['PAID', 'CONVERTED'].includes(state)) return 'badge-paid';
  if (ATTENTION_STATES.includes(state)) return 'badge-review';
  if (['CREATED', 'DETECTED', 'DEBITED', 'SWAPPED', 'BRIDGED', 'PAYOUT_DETAILS_PENDING', 'PAYOUT_FUNDING_PENDING', 'PAYOUT_FUNDED', 'PAYOUT_READY', 'PAYOUT_SUBMITTED'].includes(state)) return 'badge-open';
  return 'badge-neutral';
}

function railLabel(t) {
  if (t.kind === 'funding') return `${t.token || 'Token'} funding`;
  if (t.rail === 'sepa') return t.payout?.provider || 'Monerium';
  if (t.rail === 'cash') return t.payout?.provider || 'MoneyGram';
  return t.rail || 'Unknown';
}

function amountLabel(t) {
  if (t.kind === 'funding') {
    if (t.token === 'USDC') return `+${Number(t.amountUsdc || 0).toFixed(2)} USDC`;
    return `+€${Number(t.amountEur || 0).toFixed(2)}`;
  }
  if (t.rail === 'sepa') return `€${Number(t.sendEur || 0).toFixed(2)} → €${Number(t.receiveEur || 0).toFixed(2)}`;
  return `€${Number(t.sendEur || 0).toFixed(2)} → KES ${Number(t.receiveKes || 0).toLocaleString()}`;
}

function routeChips(t) {
  const route = Array.isArray(t.route) ? t.route : [];
  const steps = route.slice(0, 4).map(x => `<span class="route-step">${escapeHtml(x.step || x.kind)}</span>`);
  if (route.length > 4) steps.push(`<span class="route-step">+${route.length - 4}</span>`);
  if (steps.length) return steps.join('');
  const detail = t.statusDetail || t.error || 'No backend tx recorded yet';
  return `<span class="route-step">${escapeHtml(detail)}</span>`;
}

function txMatchesFilter(t) {
  if (currentTxFilter === 'all') return true;
  if (currentTxFilter === 'attention') return ATTENTION_STATES.includes(t.state) || isStale(t);
  if (currentTxFilter === 'inflight') return isInflight(t);
  if (currentTxFilter === 'funding') return t.kind === 'funding';
  return t.kind === 'transfer' && t.rail === currentTxFilter;
}

function renderTransactions() {
  const tbody = document.getElementById('transactionsTableBody');
  const query = searchInput.value.toLowerCase();
  const filtered = allTransactions.filter(t => {
    const hay = [
      t.id, t.state, t.rail, t.kind,
      t.user?.name, t.user?.id, t.user?.safeAddress,
      t.txHash, t.lastHash, t.error, t.statusDetail,
      t.payout?.orderId, t.payout?.referenceCode, t.payout?.anchorTransactionId,
      t.liquidity?.provider,
    ].filter(Boolean).join(' ').toLowerCase();
    return txMatchesFilter(t) && (!query || hay.includes(query));
  });

  document.getElementById('txCount').textContent = `${filtered.length} shown · ${allTransactions.length} total`;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);">No transactions match the criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(t => {
    const shortId = `${t.id || ''}`.slice(0, 10);
    const userName = t.user?.name || 'Unknown user';
    const userId = t.user?.id || '';
    const updated = t.updatedAt || t.createdAt || t.detectedAt;
    const routeCount = Array.isArray(t.route) ? t.route.length : 0;
    return `
      <tr>
        <td>
          <div class="detail-lines">
            <span class="detail-main">${escapeHtml(shortId)}</span>
            <span class="detail-sub">${escapeHtml(t.kind === 'funding' ? (t.txHash || '') : (t.quote?.id || ''))}</span>
          </div>
        </td>
        <td>
          <div class="user-info">
            <span class="user-name">${escapeHtml(userName)}</span>
            <span class="user-id">${escapeHtml(userId)}</span>
          </div>
        </td>
        <td><span class="badge badge-neutral">${escapeHtml(railLabel(t))}</span></td>
        <td>
          <span class="badge ${statusBadgeClass(t.state)}">${escapeHtml(t.state || 'unknown')}</span>
          ${isStale(t) ? '<span class="badge badge-pending" style="font-size:10px;padding:2px 6px">STUCK</span>' : ''}
          ${t.statusDetail ? `<div class="detail-sub">${escapeHtml(t.statusDetail)}</div>` : ''}
        </td>
        <td><strong>${escapeHtml(amountLabel(t))}</strong></td>
        <td><div class="route-stack">${routeChips(t)}</div></td>
        <td style="color: var(--text-muted); font-size: 12px;">${updated ? new Date(updated).toLocaleString() : 'Unknown'}</td>
        <td>
          ${inspectTxBtn(t, routeCount ? '⛓' : '🔍')}
        </td>
      </tr>
    `;
  }).join('');
}

/* The modal: focus moves in on open and back to whatever opened it on close,
   so a keyboard user is not dropped at the top of the page. The opener may
   have been re-rendered by then; fall back to the same row's fresh button. */
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

function inspectUser(user) {
  openModal(`User: ${user.name} (${user.id})`, user);
}

function inspectTransaction(tx) {
  openModal(`Transaction: ${tx.id}`, tx);
}

// Rows carry ids, never JSON: an inline handler built from a user's
// name is an injection point (encodeURIComponent leaves the quote
// characters that close a JS string), and the operator token lives on
// this page.
document.addEventListener('click', (ev) => {
  const u = ev.target.closest('[data-inspect-user]');
  if (u) {
    const user = allUsers.find((x) => x.id === u.dataset.inspectUser);
    if (user) inspectUser(user);
    return;
  }
  const t = ev.target.closest('[data-inspect-tx]');
  if (t) {
    const tx = allTransactions.find((x) => x.id === t.dataset.inspectTx);
    if (tx) inspectTransaction(tx);
  }
});

function closeModal() {
  if (!isModalOpen()) return;
  modalOverlay.classList.remove('open');
  let back = modalOpener;
  if (back && !back.isConnected) {
    const key = back.dataset?.inspectUser ? 'data-inspect-user' : back.dataset?.inspectTx ? 'data-inspect-tx' : null;
    const id = key && back.getAttribute(key);
    back = id ? document.querySelector(`[${key}="${CSS.escape(id)}"]`) : null;
  }
  modalOpener = null;
  back?.focus();
}

document.addEventListener('keydown', (ev) => {
  if (!isModalOpen()) return;
  if (ev.key === 'Escape') { ev.preventDefault(); closeModal(); }
  // The close button is the modal's only control: Tab stays on it rather
  // than walking into the page behind the backdrop.
  if (ev.key === 'Tab') { ev.preventDefault(); modalOverlay.querySelector('.close-btn').focus(); }
});
// A click on the backdrop (outside the panel) closes too.
modalOverlay.addEventListener('click', (ev) => { if (ev.target === modalOverlay) closeModal(); });

document.querySelectorAll('[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    setFilter('userFilterTabs', 'filter', btn.dataset.filter);
    currentFilter = btn.dataset.filter;
    renderUsers();
  });
});

document.querySelectorAll('[data-tx-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    setFilter('txFilterTabs', 'txFilter', btn.dataset.txFilter);
    currentTxFilter = btn.dataset.txFilter;
    renderTransactions();
  });
});

searchInput.addEventListener('input', () => {
  renderUsers();
  renderTransactions();
});

function fmtWhen(iso) {
  const d = new Date(iso);
  return isNaN(d) ? 'unknown' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

loadDashboard();
// The refresh rebuilds both tables and the triage list, which throws away
// keyboard focus inside them. Skip a tick while someone is working there or
// reading the modal; the next tick catches up.
setInterval(() => {
  if (isModalOpen()) return;
  const a = document.activeElement;
  if (a && a.closest('#usersTableBody, #transactionsTableBody, #attentionList, #recoveriesPanel')) return;
  loadDashboard();
}, 10000);
