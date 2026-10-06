/* Transactions: transfers out and deposits in, newest first, with the route
   of on-chain steps behind each. Recipient identifiers arrive masked. */

let txFilter = 'all';
let txQuery = '';

const TX_FILTERS = {
  all: ['All', () => true],
  attention: ['Needs attention', (t) => ATTENTION_STATES.includes(t.state) || isStale(t)],
  inflight: ['In flight', isInflight],
  sepa: ['SEPA', (t) => t.kind === 'transfer' && t.rail === 'sepa'],
  cash: ['Cash', (t) => t.kind === 'transfer' && t.rail === 'cash'],
  funding: ['Deposits', (t) => t.kind === 'funding'],
};

function routeChips(t) {
  const route = Array.isArray(t.route) ? t.route : [];
  if (!route.length) return '<span class="sub2">no on-chain step yet</span>';
  return route.slice(0, 4).map((x) => `<span class="chip" title="${esc(x.hash || '')}">${esc(x.step || x.kind)}</span>`).join('')
    + (route.length > 4 ? `<span class="chip">+${route.length - 4}</span>` : '');
}

function renderTxs(root) {
  const q = txQuery.toLowerCase();
  const [, pass] = TX_FILTERS[txFilter];
  const rows = S.txs.filter((t) => pass(t) && (!q || [
    t.id, t.state, t.rail, t.kind, t.user?.name, t.user?.id, t.user?.safeAddress, t.txHash, t.lastHash, t.error, t.statusDetail,
    t.payout?.orderId, t.payout?.referenceCode, t.liquidity?.provider,
  ].filter(Boolean).join(' ').toLowerCase().includes(q)));
  const count = (k) => S.txs.filter(TX_FILTERS[k][1]).length;
  root.innerHTML = `
    <div class="bar">
      <div class="tabs" role="group" aria-label="Filter transactions">
        ${Object.entries(TX_FILTERS).map(([k, [label]]) => `<button type="button" data-txf="${k}" aria-pressed="${txFilter === k}">${esc(label)}<span class="c">${count(k)}</span></button>`).join('')}
      </div>
      <input type="search" id="txSearch" aria-label="Search transactions" placeholder="Id, user, state, order id, tx hash" value="${esc(txQuery)}">
    </div>
    <section class="card"><div class="card-h"><h2>Transactions</h2><span class="sub">${rows.length} shown · ${S.txs.length} loaded</span></div>
      <div class="tbl-wrap" style="max-height:none"><table>
        <thead><tr><th>Updated</th><th>User</th><th>Kind</th><th>Amount</th><th>State</th><th>Route</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((t) => `<tr>
          <td><span class="sub2">${esc(fmtWhen(t.updatedAt || t.createdAt))}</span>${chip(String(t.id).slice(0, 12))}</td>
          <td class="who">${t.user ? `<a href="${href('users', t.user.id)}"><b>${esc(t.user.name || t.user.id)}</b></a>` : '—'}</td>
          <td>${esc(railLabel(t))}</td>
          <td class="num">${esc(amountLabel(t))}</td>
          <td>${txPill(t)}${t.statusDetail ? `<span class="sub2">${esc(t.statusDetail)}</span>` : ''}</td>
          <td>${routeChips(t)}</td>
          <td><button type="button" class="btn sm ghost" data-tx="${esc(t.id)}">Open</button>${t.kind === 'transfer' && t.state === 'MANUAL_REVIEW' ? ` <button type="button" class="btn sm" data-resolve="${esc(t.id)}">Resolve</button>` : ''}</td>
        </tr>`).join('') : empty(7, 'No transactions match.')}</tbody>
      </table></div></section>`;
  root.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', () => resolveReview(root, b.dataset.resolve)));
  root.querySelectorAll('[data-txf]').forEach((b) => b.addEventListener('click', () => { txFilter = b.dataset.txf; renderTxs(root); }));
  const s = root.querySelector('#txSearch');
  s.addEventListener('input', () => { txQuery = s.value; renderTxs(root); const n = root.querySelector('#txSearch'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
}

/* Close a MANUAL_REVIEW transfer with what the operator decided. This moves
   no money: it records an outcome the operator already brought about on chain
   or at the partner, so it asks for the state, a note and a confirmation.
   PAID also asks for the payout identifier the transfer recorded; REFUNDED
   for the euros returned and the refund tx hash or partner reference. */
const RESOLVE_STATES = ['REFUNDED', 'PAID', 'FAILED'];
async function resolveReview(root, id) {
  const state = (prompt(`Resolve ${id} as which state? ${RESOLVE_STATES.join(', ')}`) || '').trim().toUpperCase();
  if (!state) return;
  if (!RESOLVE_STATES.includes(state)) { alert(`State must be one of ${RESOLVE_STATES.join(', ')}.`); return; }
  const body = { state };
  if (state === 'PAID') {
    const evidence = (prompt('Evidence the payout was carried out: the Monerium order id once Monerium reports it processed, the destination tx hash Bridge reported, or the anchor payment hash this transfer recorded') || '').trim();
    if (!evidence) return;
    body.evidence = evidence;
  }
  if (state === 'REFUNDED') {
    const amount = (prompt('Euros returned to the user (0 up to what left their Safe)') || '').trim().replace(',', '.');
    if (!amount) return;
    const amountEur = Number(amount);
    if (!Number.isFinite(amountEur) || amountEur < 0) { alert('The amount must be a number of euros, 0 or more.'); return; }
    const evidence = (prompt('Evidence of the refund: the refund tx hash or the partner\'s reference') || '').trim();
    if (!evidence) return;
    body.amountEur = amountEur;
    body.evidence = evidence;
  }
  const note = (prompt('What did you check, and what did you do? (at least 20 characters)') || '').trim();
  if (!note) return;
  body.note = note;
  const stateWarning = state === 'PAID'
    ? '\n\nPAID also settles any pay link, invoice or Shopify order linked to this transfer.'
    : state === 'REFUNDED'
      ? `\n\nThe user's statement and app will show €${body.amountEur.toFixed(2)} refunded.`
      : '';
  if (!confirm(`Record ${id} as ${state}?\n\nThis moves no money and cannot be undone.${stateWarning}\n\n${note}`)) return;
  try {
    await api(`/api/admin/transfers/${encodeURIComponent(id)}/resolve-review`, { method: 'POST', body: JSON.stringify(body) });
    await loadTxs();
    renderTxs(root);
  } catch (err) {
    alert(`Not resolved: ${err.message}`);
  }
}

VIEWS.transactions = {
  title: 'Transactions',
  async load() { await loadTxs(); },
  render: renderTxs,
};
