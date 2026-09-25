/**
 * The operator dashboard.
 *
 * Read only: every route behind it is a read. KYC review and IBAN issue belong
 * to Monerium.
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
tokenInput.addEventListener('input', () => {
  sessionStorage.setItem('zold_operator_token', tokenInput.value);
  loadDashboard();
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
  } catch (err) {
    console.error("Dashboard error:", err);
  }
}

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
        actions: `<button class="btn-icon" data-inspect-user="${escapeHtml(u.id)}" title="View JSON">🔍</button>`,
      });
    } else if (u.kycStatus === 'approved' && !u.iban) {
      items.push({
        kind: 'iban', label: 'IBAN', who: u.name || u.id,
        why: (u.passkeySafe?.status === 'active' || u.wallet?.deployed)
          ? 'approved, Safe deployed, no IBAN yet — Monerium issues it; the user activates with a passkey tap'
          : 'approved but smart wallet not finished — user must complete onboarding first',
        actions: `<button class="btn-icon" data-inspect-user="${escapeHtml(u.id)}" title="View JSON">🔍</button>`,
      });
    }
  }
  for (const t of allTransactions) {
    if (ATTENTION_STATES.includes(t.state)) {
      items.push({
        kind: 'tx', label: t.state, who: t.user?.name || t.user?.id || 'unknown',
        why: `${railLabel(t)} · ${amountLabel(t)} · ${t.statusDetail || t.error || ''}`,
        actions: `<button class="btn-icon" data-inspect-tx="${escapeHtml(t.id)}">🔍</button>`,
      });
    } else if (isStale(t)) {
      items.push({
        kind: 'stale', label: 'STUCK', who: t.user?.name || t.user?.id || 'unknown',
        why: `${railLabel(t)} · ${amountLabel(t)} · in ${t.state} since ${fmtWhen(t.updatedAt || t.createdAt)}`,
        actions: `<button class="btn-icon" data-inspect-tx="${escapeHtml(t.id)}">🔍</button>`,
      });
    }
  }
  return items;
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
    b.classList.toggle('active', b.dataset[dataKey] === value);
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
            <button class="btn-icon" data-inspect-user="${escapeHtml(u.id)}" title="View JSON">🔍</button>
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
          <button class="btn-icon" data-inspect-tx="${escapeHtml(t.id)}" title="View route JSON">${routeCount ? '⛓' : '🔍'}</button>
        </td>
      </tr>
    `;
  }).join('');
}

function inspectUser(user) {
  document.getElementById('modalTitle').textContent = `User: ${user.name} (${user.id})`;
  document.getElementById('modalJson').textContent = JSON.stringify(user, null, 2);
  document.getElementById('modalOverlay').classList.add('open');
}

function inspectTransaction(tx) {
  document.getElementById('modalTitle').textContent = `Transaction: ${tx.id}`;
  document.getElementById('modalJson').textContent = JSON.stringify(tx, null, 2);
  document.getElementById('modalOverlay').classList.add('open');
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
  document.getElementById('modalOverlay').classList.remove('open');
}

document.querySelectorAll('[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderUsers();
  });
});

document.querySelectorAll('[data-tx-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-tx-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
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
setInterval(loadDashboard, 10000);
