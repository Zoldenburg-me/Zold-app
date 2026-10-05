/* Recoveries through Zoldenburg as guardian.
 *
 * A person who lost their passkey asks support; the operator checks them
 * against the identity Monerium verified and signs as guardian from the
 * Keycard Shell (through MetaMask/Rabby, or Safe Cover). The API moves a
 * request only on what the chain shows. This page tracks every request from
 * "new passkey registered" to "recovered", and lists who enrolled Zoldenburg
 * as their guardian at all. */

let rvFilter = 'open';
const RV_OPEN = ['PASSKEY_PENDING', 'REVIEW_PENDING', 'GRACE_PERIOD'];
const RV_FILTERS = {
  open: ['Open', (r) => RV_OPEN.includes(r.status)],
  review: ['Needs review', (r) => r.status === 'REVIEW_PENDING'],
  grace: ['Waiting period', (r) => r.status === 'GRACE_PERIOD'],
  done: ['Recovered', (r) => r.status === 'FINALIZED'],
  closed: ['Cancelled / expired', (r) => ['CANCELED', 'EXPIRED'].includes(r.status)],
  all: ['All', () => true],
};

/* The four stages of a request and where this one stands. */
function rvStages(r) {
  const z = r.zoldenburg || {};
  const stopped = ['CANCELED', 'EXPIRED'].includes(r.status);
  const reached = [
    Boolean(z.newPasskeyRegistered) || r.status !== 'PASSKEY_PENDING',
    Boolean(z.executeTxHash || z.executedAt) || ['GRACE_PERIOD', 'FINALIZED'].includes(r.status),
    r.status === 'FINALIZED' || (r.status === 'GRACE_PERIOD' && z.finalizeAfter && Date.now() >= Date.parse(z.finalizeAfter)),
    r.status === 'FINALIZED',
  ];
  const cur = reached.indexOf(false);
  return [
    { label: 'Passkey registered', when: r.requestedAt },
    { label: 'Guardian signed', when: z.executedAt, sub: r.reviewedBy ? 'reviewed' : '' },
    { label: 'Waiting period over', when: z.finalizeAfter, sub: r.status === 'GRACE_PERIOD' ? fmtAgo(z.finalizeAfter) : '' },
    { label: 'Recovered', when: r.finalizedAt },
  ].map((s, i) => ({ ...s, state: reached[i] ? 'on' : i === cur ? (stopped ? 'stop' : 'cur') : '' }));
}

function miniTimeline(r) {
  return `<span class="mini-tl" aria-hidden="true">${rvStages(r).map((s) => `<i class="${s.state}"></i>`).join('')}</span>`;
}

function renderRecoveryList(root) {
  const rv = S.recoveries;
  const rows = (rv.requests || []).filter(RV_FILTERS[rvFilter][1]);
  const count = (k) => (rv.requests || []).filter(RV_FILTERS[k][1]).length;
  const enrol = rv.enrolments || [];
  root.innerHTML = `
    <div class="kpis">
      <button type="button" class="card kpi ${count('review') ? 'warn' : ''}" data-rvf="review"><span class="k">Needs review</span><span class="v">${count('review')}</span><span class="s">waiting on an operator</span></button>
      <button type="button" class="card kpi" data-rvf="grace"><span class="k">Waiting period</span><span class="v">${count('grace')}</span><span class="s">old passkey can still cancel</span></button>
      <button type="button" class="card kpi" data-rvf="open"><span class="k">No passkey yet</span><span class="v">${(rv.requests || []).filter((r) => r.status === 'PASSKEY_PENDING').length}</span><span class="s">started, not finished</span></button>
      <button type="button" class="card kpi good" data-rvf="done"><span class="k">Recovered</span><span class="v">${count('done')}</span><span class="s">${count('closed')} cancelled or expired</span></button>
      <div class="card kpi"><span class="k">Guardian enrolled</span><span class="v">${enrol.filter((e) => e.zoldenburg === 'active').length}</span><span class="s">${enrol.filter((e) => e.zoldenburg === 'pending').length} pending · ${enrol.filter((e) => e.zoldenburg === 'declined').length} declined</span></div>
    </div>

    <section class="card"><div class="card-h"><h2>Guardian</h2>
      <button type="button" class="btn sm" id="rvCheckBtn" ${rv.enabled ? '' : 'disabled'}>Test guardian wallet</button></div>
      <div class="card-b">
        ${rv.enabled
          ? `<div class="facts">${fact('Guardian address', chip(rv.guardianAddress), true)}${fact('Chain', rv.chainId)}${fact('Signs from', 'Keycard Shell (hardware, QR)')}</div>`
          : '<div class="note warn">Not configured — CANDIDE_RECOVERY_GUARDIAN_ADDRESS is unset, so no one can enrol Zoldenburg and no request can be signed.</div>'}
        <div id="rvCheckMsg" role="status" aria-live="polite"></div>
      </div></section>

    <section class="card"><div class="card-h"><h2>Recovery requests</h2>
      <div class="tabs" role="group" aria-label="Filter recovery requests">
        ${Object.entries(RV_FILTERS).map(([k, [label]]) => `<button type="button" data-rvf="${k}" aria-pressed="${rvFilter === k}">${esc(label)}<span class="c">${count(k)}</span></button>`).join('')}
      </div></div>
      ${objTable(rows, [
        ['Reference', (r) => chip(r.zoldenburg?.reference)],
        ['Account', (r) => `<span class="who"><b>${esc(r.account?.name || '—')}</b><span>${esc(r.account?.email || r.account?.id || '')}</span></span>`],
        ['Monerium', (r) => kycPill(r.account?.kycStatus)],
        ['Progress', (r) => `${miniTimeline(r)} ${rvPillFor(r.status)}`],
        ['Requested', (r) => `${esc(fmtWhen(r.requestedAt))}<span class="sub2">${esc(fmtAgo(r.requestedAt))}</span>`],
        ['Next', (r) => esc(r.status === 'GRACE_PERIOD' ? `finalizable ${fmtAgo(r.zoldenburg?.finalizeAfter)}` : RV_OPEN.includes(r.status) ? `expires ${fmtAgo(r.expiresAt)}` : '—')],
        ['', (r) => `<a class="btn sm ${r.status === 'REVIEW_PENDING' ? 'primary' : 'ghost'}" href="${href('recoveries', r.id)}">${r.status === 'REVIEW_PENDING' ? 'Review' : 'Open'}</a>`],
      ], 'No recovery requests here.')}</section>

    <section class="card"><div class="card-h"><h2>Who chose Zoldenburg</h2><span class="sub">accounts an operator could be asked to recover</span></div>
      ${objTable(enrol, [
        ['Account', (e) => `<a class="who" href="${href('users', e.userId)}"><b>${esc(e.name || e.userId)}</b><span>${esc(e.email || '')}</span></a>`],
        ['Choice', (e) => enrolPill(e.zoldenburg)],
        ['Chosen', (e) => esc(fmtWhen(e.chosenAt))],
        ['On chain since', (e) => esc(fmtWhen(e.enabledAt))],
        ['Safe', (e) => chip(short(e.safeAddress))],
      ], 'No account has made a recovery choice yet.')}</section>`;
}

function renderRecoveryDetail(root, id, message) {
  const r = (S.recoveries.requests || []).find((x) => x.id === id);
  if (!r) { root.innerHTML = `<a class="back" href="#/recoveries">← All recoveries</a><div class="note">No Zoldenburg recovery with this id.</div>`; return; }
  const a = r.account || {};
  const z = r.zoldenburg || {};
  const review = r.status === 'REVIEW_PENDING';
  const grace = r.status === 'GRACE_PERIOD';
  const ready = grace && z.finalizeAfter && Date.now() >= Date.parse(z.finalizeAfter);
  root.innerHTML = `
    <a class="back" href="#/recoveries">← All recoveries</a>
    <section class="card"><div class="card-h">
        <div><h2 style="font-size:18px">Recovery ${chip(z.reference)}</h2><span class="sub">${esc(a.name || '')} · requested ${esc(fmtWhen(r.requestedAt))}</span></div>
        <div class="actions">${rvPillFor(r.status)} <button type="button" class="btn sm ghost" data-rv-raw>Raw</button></div></div>
      <div class="card-b stack">
        <div class="timeline">${rvStages(r).map((s) => `<div class="${s.state}"><b>${esc(s.label)}</b>${esc(s.when ? fmtWhen(s.when) : '—')}${s.sub ? ` · ${esc(s.sub)}` : ''}</div>`).join('')}</div>
        <div class="facts">
          ${fact('Name', a.name)}
          ${fact('Email', a.email)}
          ${fact('Country', a.country)}
          ${fact('Monerium KYC', kycPill(a.kycStatus), true)}
          ${fact('Monerium link', a.moneriumMethod ? `${a.moneriumMethod}${a.moneriumProfileId ? ` · profile ${a.moneriumProfileId}` : ''}` : 'not connected')}
          ${fact('IBAN', a.iban)}
          ${fact('Account created', fmtWhen(a.createdAt))}
          ${fact('Safe', chip(r.safeAddress), true)}
          ${fact('New owner (new passkey)', (z.newOwners || []).map(chip).join(' ') || '—', true)}
          ${fact(grace ? 'Finalizable after' : 'Expires', grace ? fmtWhen(z.finalizeAfter) : fmtWhen(r.expiresAt))}
          ${z.executeTxHash ? fact('Execute tx', chip(z.executeTxHash), true) : ''}
          ${z.finalizeTxHash ? fact('Finalize tx', chip(z.finalizeTxHash), true) : ''}
          ${r.reviewedBy ? fact('Reviewed by', r.reviewedBy) : ''}
          ${r.reviewReason ? fact('Review note', r.reviewReason) : ''}
          ${r.cancelReason ? fact('Cancel reason', r.cancelReason) : ''}
          ${z.finalizeAttempts ? fact('Finalize attempts', z.finalizeAttempts) : ''}
        </div>
        ${z.finalizeError ? `<div class="note bad"><b>Last finalize error.</b> ${esc(z.finalizeError)}</div>` : ''}
        ${a.id ? `<div><a href="${href('users', a.id)}">Open the account and its Monerium data →</a></div>` : ''}
      </div></section>

    ${review ? `<section class="card"><div class="card-h"><h2>Review and sign</h2></div><div class="card-b stack" id="rvActions">
      <div class="note warn">
        <b>Before you sign.</b> Signing starts a takeover of this account: after the waiting period the new passkey owns it. Only the old passkey can stop it.
        <ol>
          <li>The person wrote from <b>${esc(a.email || 'the account email')}</b> and quoted reference <b translate="no">${esc(z.reference || '')}</b>.</li>
          <li>You checked them against the identity Monerium verified (${a.kycStatus === 'approved' ? 'approved' : '<b>NOT approved</b>'}) — Zold holds the result, not the documents.</li>
          <li>Anything unusual (new email, urgency, a third party speaking for them) → reject.</li>
        </ol>
      </div>
      <div>
        <label for="rvNote">How you verified the person (stored with the request)</label>
        <textarea id="rvNote" rows="2" placeholder="e.g. Video call 29 Sep, matched name and DOB with Monerium profile, email from account address" autocomplete="off"></textarea>
      </div>
      <div class="actions">
        ${r.safeCoverLink
          ? `<a class="btn" href="${esc(r.safeCoverLink)}" target="_blank" rel="noopener noreferrer">Open in Safe Cover ↗</a>
             <button type="button" class="btn" data-rv="sync">I signed in Safe Cover — check chain</button>`
          : `<span class="sub2">Safe Cover does not list chain ${esc(S.recoveries.chainId)} — sign here</span>`}
        <button type="button" class="btn primary" data-rv="sign">Sign with Keycard Shell</button>
      </div>
      <details>
        <summary>Signed on another device? Paste the signature</summary>
        <div class="actions" style="margin:10px 0"><button type="button" class="btn sm" data-rv="payload">Show typed data to sign</button></div>
        <pre class="json" id="rvPayload" hidden></pre>
        <label for="rvSig" style="margin-top:10px">eth_signTypedData_v4 signature (0x…, 65 bytes)</label>
        <textarea id="rvSig" class="mono" rows="2" autocomplete="off" spellcheck="false"></textarea>
        <div class="actions" style="margin-top:10px"><button type="button" class="btn primary" data-rv="execute">Relay signature</button></div>
      </details>
      <div>
        <label for="rvReason">Reject — reason the person will see</label>
        <input type="text" id="rvReason" autocomplete="off" placeholder="e.g. We could not verify your identity. Contact support@zoldhq.com.">
        <div class="actions" style="margin-top:10px"><button type="button" class="btn danger" data-rv="reject">Reject request</button></div>
      </div>
      <div id="rvMsg" role="status" aria-live="polite">${message || ''}</div>
    </div></section>` : ''}

    ${grace ? `<section class="card"><div class="card-h"><h2>Waiting period</h2></div><div class="card-b stack" id="rvActions">
      <div class="note">The recovery is on chain. The owner's old passkey can cancel it until <b>${esc(fmtWhen(z.finalizeAfter))}</b> (${esc(fmtAgo(z.finalizeAfter))}); after that the sweep finalizes it and binds the new passkey.</div>
      <div class="actions"><button type="button" class="btn primary" data-rv="finalize" ${ready ? '' : 'disabled'}>Finalize now</button></div>
      <div id="rvMsg" role="status" aria-live="polite">${message || ''}</div>
    </div></section>` : (!review && message ? `<div class="note">${message}</div>` : '')}`;
}

async function recoveryAction(id, path, body) {
  return api(`/api/admin/recoveries/${encodeURIComponent(id)}/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
}

function rvMessage(text, ok) {
  const el = document.getElementById('rvMsg');
  if (el) el.innerHTML = `<span class="${ok ? 'ok-msg' : 'err-msg'}">${esc(text)}</span>`;
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
  const line = (k, v) => `<li><span class="sub2" style="display:inline">${esc(k)}</span> <span class="mono" translate="no">${esc(v)}</span></li>`;
  return `<div class="note warn"><b>Scan the QR with Keycard Shell and check its screen shows exactly:</b>
    <ul style="list-style:none;margin-left:0;display:grid;gap:4px">
      ${line('Domain', `${d.name} ${d.version}`)}
      ${line('Chain', d.chainId)}
      ${line('Contract', d.verifyingContract)}
      ${line('wallet (the Safe)', m.wallet)}
      ${line('newOwners', m.newOwners.join(', '))}
      ${line('newThreshold', m.newThreshold)}
      ${line('nonce', m.nonce)}
    </ul>Approve on the Shell, then scan its answer QR back into the wallet.</div>`;
}

async function afterRecoveryAction(root, id, text) {
  await loadRecoveries();
  renderRecoveryDetail(root, id, `<span class="ok-msg">${esc(text)}</span>`);
}

async function guardianCheck(btn) {
  const out = document.getElementById('rvCheckMsg');
  const say = (text, ok) => { out.innerHTML = `<p class="${ok ? 'ok-msg' : 'err-msg'}" style="margin:10px 0 0">${esc(text)}</p>`; };
  btn.disabled = true;
  try {
    const c = await api('/api/admin/recoveries/guardian-check/challenge', { method: 'POST', body: '{}' });
    say('Sign the test message on the Keycard Shell. It approves nothing and touches no Safe.', true);
    const signature = await walletSign(c.guardianAddress, c.typedData);
    const v = await api('/api/admin/recoveries/guardian-check', { method: 'POST', body: JSON.stringify({ issuedAt: c.typedData.message.issuedAt, signature }) });
    say(`Guardian wallet works: the signature recovers to ${v.guardianAddress}.`, true);
  } catch (err) {
    say(err?.message || String(err));
  } finally {
    btn.disabled = false;
  }
}

async function recoveryClick(ev, root, id) {
  const f = ev.target.closest('[data-rvf]');
  if (f && !id) { rvFilter = f.dataset.rvf; renderRecoveryList(root); return; }
  const chk = ev.target.closest('#rvCheckBtn');
  if (chk) { await guardianCheck(chk); return; }
  if (ev.target.closest('[data-rv-raw]')) { openModal(`Recovery ${id}`, (S.recoveries.requests || []).find((x) => x.id === id)); return; }
  const act = ev.target.closest('[data-rv]');
  if (!act || !id) return;
  act.disabled = true;
  try {
    const kind = act.dataset.rv;
    const note = () => (document.getElementById('rvNote')?.value || '').trim();
    if (kind === 'sign') {
      if (note().length < 10) return rvMessage('Record how you verified the person first.');
      rvMessage('Preparing the recovery…', true);
      const req = await recoveryAction(id, 'sign-request');
      document.getElementById('rvMsg').innerHTML = deviceChecklist(req);
      const signature = await walletSign(req.guardianAddress, req.typedData);
      rvMessage('Relaying and waiting for the chain…', true);
      await recoveryAction(id, 'execute', { signature, reviewNote: note() });
      await afterRecoveryAction(root, id, 'Signed and executed. The waiting period has started.');
    } else if (kind === 'payload') {
      const req = await recoveryAction(id, 'sign-request');
      const pre = document.getElementById('rvPayload');
      pre.hidden = false;
      pre.textContent = `Guardian: ${req.guardianAddress}\nDigest:   ${req.digest}\n\n${JSON.stringify(req.typedData, null, 2)}`;
    } else if (kind === 'execute') {
      if (note().length < 10) return rvMessage('Record how you verified the person first.');
      rvMessage('Relaying and waiting for the chain…', true);
      await recoveryAction(id, 'execute', { signature: document.getElementById('rvSig').value.trim(), reviewNote: note() });
      await afterRecoveryAction(root, id, 'Signed and executed. The waiting period has started.');
    } else if (kind === 'sync') {
      const updated = await recoveryAction(id, 'sync', { reviewNote: note() });
      if (updated.status === 'REVIEW_PENDING') rvMessage('The chain shows no recovery for this Safe yet. Finish confirm + execute in Safe Cover, then check again.');
      else await afterRecoveryAction(root, id, 'Seen on chain. The waiting period has started.');
    } else if (kind === 'reject') {
      const reason = document.getElementById('rvReason').value.trim();
      if (!reason) return rvMessage('Give a reason — the person sees it.');
      if (!confirm('Reject this recovery request?')) return;
      await recoveryAction(id, 'reject', { reason });
      await afterRecoveryAction(root, id, 'Rejected.');
    } else if (kind === 'finalize') {
      const updated = await recoveryAction(id, 'finalize');
      await afterRecoveryAction(root, id, updated.status === 'FINALIZED' ? 'Finalized. The new passkey owns the account.' : 'Not finalized yet — see the error above.');
    }
  } catch (err) {
    rvMessage(err?.message || String(err));
  } finally {
    if (act.isConnected) act.disabled = false;
  }
}

VIEWS.recoveries = {
  title: 'Recoveries',
  async load() { await loadRecoveries(); },
  render(root, id) { if (id) renderRecoveryDetail(root, id); else renderRecoveryList(root); },
  click: recoveryClick,
  /* A refresh would wipe a half-written review note: hold it while the
     operator is working in the action area. */
  busy() { return [...(document.getElementById('rvActions')?.querySelectorAll('textarea, input') || [])].some((e) => e.value); },
};
