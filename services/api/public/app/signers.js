/**
 * Advanced security: signers and rules on the smart account.
 *
 * Opened from Settings and Security (app/settings.js). Everything
 * shown is read from the chain on each visit (GET /safe/signers), because an
 * owner added or removed on app.safe.global changes it without Zold hearing.
 * Every change is a passkey-signed operation: prepare → sign → submit.
 */
let signersState = null;  // last GET /safe/signers
let signersView = "main"; // main | owner | lock | limit

const sgAddr = (a) => `<span translate="no" style="font-family:var(--m-mono);text-transform:none;letter-spacing:0" title="${esc(a)}">${esc(shortAddr(a))}</span>`;

function sgLimitAmount(l, tokens) {
  const t = tokens.find((x) => x.address.toLowerCase() === l.token.toLowerCase());
  if (!t) return { symbol: "token", amount: "—", spent: "—" };
  const f = (base) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(BigInt(base)) / 10 ** t.decimals);
  return { symbol: t.symbol, amount: f(l.amount), spent: f(l.spent) };
}
const sgPeriodLabel = (min) => !min ? "one-time" : min === 1440 ? "per day" : min === 10080 ? "per week" : min === 43200 ? "per month" : `every ${min} min`;

/** Prepare an op, have the passkey sign it, submit it, and show the new state. */
async function signersRun(path, body, errId, btn) {
  clearErr(errId);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    const prepared = await api(path, body);
    btn.textContent = "Confirm with your passkey…";
    const sig = await passkeySignPrepared(prepared);
    btn.textContent = "Waiting for the chain…";
    signersState = await api(prepared.submitTo, sig);
    signersView = "main";
    renderSignersScreen(prepared.summary);
  } catch (e) {
    showErr(errId, e);
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function renderSignersScreen(done) {
  const el = $("m-sg-body");
  if (signersView !== "main" && signersState) return renderSignersForm(el);
  el.innerHTML = `<div class="m-lede" style="font-size:13px" aria-live="polite">Reading your smart account…</div>`;
  try { signersState = await api(`/api/users/${user.id}/safe/signers`); }
  catch (e) { el.innerHTML = `<div class="m-err" role="alert">${esc(e.message)}</div>`; return; }
  const s = signersState;
  const second = s.owners.filter((o) => o.kind !== "passkey");
  const locked = s.threshold > 1;
  const limits = s.allowance.limits.filter((l) => l.token !== "0x0000000000000000000000000000000000000000");
  // Letting someone else spend is offered to people who work with a business.
  // A limit already on the account is always listed, whoever set it.
  const offerLimits = (await phLoadOrgs()).some((o) => o.type === "business");
  const bareDelegates = s.allowance.limits.filter((l) => l.token === "0x0000000000000000000000000000000000000000");

  el.innerHTML = `
    <div aria-live="polite">${done ? `<div class="m-note info" role="status"><span class="material-symbols-rounded" aria-hidden="true">task_alt</span><div>Done on chain. ${esc(done)}</div></div>` : ""}</div>
    ${locked ? `<div class="m-note warn" role="alert"><span class="material-symbols-rounded" aria-hidden="true">lock</span><div>
      This account needs ${s.threshold} of ${s.owners.length} signatures. Zold can give only your passkey's, so sending, converting and changing settings from Zold will be refused. Recovery is the only way to reset it.</div></div>` : ""}

    <div class="m-seclabel">Owners · ${s.threshold} of ${s.owners.length} signature${s.owners.length === 1 ? "" : "s"} needed</div>
    <div class="m-rows">
      ${s.owners.map((o) => `
        <div class="m-secrow">
          <span class="material-symbols-rounded" aria-hidden="true">${o.kind === "passkey" ? "fingerprint" : "security_key"}</span>
          <div style="flex:1;min-width:0">
            <div class="t">${o.kind === "passkey" ? "Your passkey" : "Second owner"}</div>
            <div class="d" style="overflow-wrap:anywhere">${o.kind === "passkey" ? "How Zold signs. Works only in Zold." : `${sgAddr(o.address)} · can act on app.safe.global`}</div>
          </div>
          ${o.kind === "passkey" ? `<span class="st" style="color:var(--m-mint)">Owner</span>`
            : `<button class="m-copybtn" data-sg-remove-owner="${esc(o.address)}" ${locked ? "disabled" : ""} aria-label="Remove owner ${esc(o.address)}">Remove</button>`}
        </div>`).join("")}
    </div>
    ${second.length ? "" : `
      <button class="m-optrow" id="m-sg-add-owner" style="margin-top:8px">
        <span class="material-symbols-rounded ic" aria-hidden="true">person_add</span>
        <span class="tx"><span class="t">Add a second owner</span><span class="d">A hardware wallet you hold. It can manage the account without Zold.</span></span>
        <span class="material-symbols-rounded ch" aria-hidden="true">chevron_right</span>
      </button>`}

    <div class="m-seclabel">Cosigner rules</div>
    <div class="m-rows">
      <div class="m-secrow">
        <span class="material-symbols-rounded" aria-hidden="true">group</span>
        <div style="flex:1;min-width:0">
          <div class="t">Require the second owner on every transaction</div>
          <div class="d">${locked ? "On. Zold can no longer sign on its own." : second.length ? "Off. Either owner can move funds alone." : "Needs a second owner first."}</div>
        </div>
        ${locked ? `<span class="st" style="color:var(--m-amber)">On</span>`
          : `<button class="m-copybtn" id="m-sg-lock" ${second.length ? "" : "disabled"}>Turn On…</button>`}
      </div>
      ${limits.map((l) => { const a = sgLimitAmount(l, s.tokens); return `
        <div class="m-secrow">
          <span class="material-symbols-rounded" aria-hidden="true">savings</span>
          <div style="flex:1;min-width:0">
            <div class="t" style="font-variant-numeric:tabular-nums">${esc(a.amount)} ${esc(a.symbol)} ${esc(sgPeriodLabel(l.resetTimeMin))}</div>
            <div class="d" style="overflow-wrap:anywhere">${sgAddr(l.delegate)} · ${esc(a.spent)} ${esc(a.symbol)} spent this period</div>
          </div>
          <button class="m-copybtn" data-sg-remove-delegate="${esc(l.delegate)}" ${locked ? "disabled" : ""} aria-label="Remove spending limits for ${esc(l.delegate)}">Remove</button>
        </div>`; }).join("")}
      ${bareDelegates.map((l) => `
        <div class="m-secrow">
          <span class="material-symbols-rounded" aria-hidden="true">savings</span>
          <div style="flex:1;min-width:0"><div class="t">Delegate with no limit set</div><div class="d">${sgAddr(l.delegate)}</div></div>
          <button class="m-copybtn" data-sg-remove-delegate="${esc(l.delegate)}" ${locked ? "disabled" : ""} aria-label="Remove delegate ${esc(l.delegate)}">Remove</button>
        </div>`).join("")}
    </div>
    ${offerLimits ? `<button class="m-optrow${s.allowance.moduleDeployed && !locked ? "" : " off"}" id="m-sg-add-limit" style="margin-top:8px" ${s.allowance.moduleDeployed && !locked ? "" : "disabled"}>
      <span class="material-symbols-rounded ic" aria-hidden="true">add_card</span>
      <span class="tx"><span class="t">Allow someone to spend from your account <span class="m-tag">ADVANCED</span></span><span class="d">${s.allowance.moduleDeployed
        ? "Up to a limit you set, without your signature."
        : "The Allowance module is not deployed on this chain."}</span></span>
      <span class="material-symbols-rounded ch" aria-hidden="true">chevron_right</span>
    </button>` : ""}
    <div class="m-err hidden" id="m-sg-err" role="alert" style="margin-top:12px"></div>

    <div class="m-seclabel">Recovery with two owners</div>
    <div class="m-lede" style="font-size:13px;margin-top:0">
      ${s.guardians ? `A recovery guardian is on this account.` : `<strong>No recovery guardian is on this account.</strong>`}
      A recovery replaces <em>every</em> owner with your new passkey at 1 signature: the second owner is removed and the cosigner rule is reset.
      Spending limits are <em>not</em> touched by a recovery — remove them yourself.
      ${caps.emailSmsRecovery ? "" : "Recovery here is manual and operator-reviewed; email / SMS recovery is not offered on this deployment."}
    </div>
    <a class="m-optrow" href="${esc(s.safeAppUrl)}" target="_blank" rel="noopener noreferrer" style="margin-top:12px;text-decoration:none">
      <span class="material-symbols-rounded ic" aria-hidden="true">open_in_new</span>
      <span class="tx"><span class="t">Open in Safe{Wallet}</span><span class="d">app.safe.global — where the second owner signs</span></span>
    </a>`;

  const add = $("m-sg-add-owner");
  if (add) add.onclick = () => { signersView = "owner"; renderSignersForm(el); };
  const lock = $("m-sg-lock");
  if (lock) lock.onclick = () => { signersView = "lock"; renderSignersForm(el); };
  const lim = $("m-sg-add-limit");
  if (lim) lim.onclick = () => { if (!lim.disabled) { signersView = "limit"; renderSignersForm(el); } };
  el.querySelectorAll("[data-sg-remove-owner]").forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.sgRemoveOwner;
      if (!confirm(`Remove ${a} as an owner? It will no longer be able to sign for this account.`)) return;
      signersRun(`/api/users/${user.id}/safe/owners/${a}/remove`, {}, "m-sg-err", b);
    };
  });
  el.querySelectorAll("[data-sg-remove-delegate]").forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.sgRemoveDelegate;
      if (!confirm(`Remove ${a} and every spending limit it holds?`)) return;
      signersRun(`/api/users/${user.id}/safe/spending-limits/${a}/remove`, {}, "m-sg-err", b);
    };
  });
}

const sgWarnItem = (icon, title, body) => `
  <div class="m-secrow" style="align-items:flex-start">
    <span class="material-symbols-rounded" aria-hidden="true" style="margin-top:2px">${icon}</span>
    <div style="flex:1;min-width:0"><div class="t">${title}</div><div class="d" style="font-size:12px;line-height:1.5">${body}</div></div>
  </div>`;

const sgAckBox = (id, text) => `
  <label for="${id}" style="display:flex;gap:10px;align-items:flex-start;padding:14px 0;font-size:13.5px;line-height:1.5;cursor:pointer">
    <input type="checkbox" id="${id}" style="width:18px;height:18px;margin-top:2px;flex:none;accent-color:var(--m-pink)" />${text}</label>`;

function renderSignersForm(el) {
  const s = signersState;
  const back = `<button class="m-cta quiet" id="m-sg-back" type="button">Back</button>`;
  const second = s.owners.find((o) => o.kind !== "passkey");

  if (signersView === "owner") {
    el.innerHTML = `
      <div class="m-h1" style="font-size:24px">Add a second owner</div>
      <div class="m-note warn" role="note"><span class="material-symbols-rounded" aria-hidden="true">warning</span>
        <div>Use a secured hardware wallet. Whoever holds this key can move everything in the account, without your passkey and without Zold.</div></div>
      <div class="m-rows" style="margin-top:12px">
        ${sgWarnItem("open_in_new", "It works without Zold", "The second wallet can manage this account on app.safe.global without the Zold app or your passkey.")}
        ${sgWarnItem("group", "1 of 2 signatures", "The threshold stays at 1 of 2: either owner can move funds alone. Finer controls — requiring both, or spending limits — are in Cosigner rules.")}
        ${sgWarnItem("link_off", "Zold cannot connect this wallet", "Zold does not offer connecting a second signer to its app. A rule that needs a signature Zold cannot collect makes the account unusable here and can brick it; the only way back is a manual recovery that resets the rules.")}
        ${sgWarnItem("restart_alt", "Recovery removes it", "A recovery replaces every owner with your new passkey. This wallet would have to be added again afterwards.")}
      </div>
      <div class="m-field" style="margin-top:16px"><label for="m-sg-owner-addr">Owner address</label>
        <input id="m-sg-owner-addr" name="owner-address" autocomplete="off" spellcheck="false" autocapitalize="off" inputmode="text" placeholder="0x…" translate="no" /></div>
      ${sgAckBox("m-sg-owner-ack", "I understand this address can move all funds on its own, and that Zold cannot use it.")}
      <button class="m-cta" id="m-sg-owner-go" type="button">Sign with Passkey to Add Owner</button>
      <div class="m-err hidden" id="m-sg-form-err" role="alert" style="margin-top:12px"></div>
      ${back}`;
    $("m-sg-owner-go").onclick = () => {
      const address = $("m-sg-owner-addr").value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { showErr("m-sg-form-err", new Error("Enter a 0x address of 40 hex characters.")); $("m-sg-owner-addr").focus(); return; }
      if (!$("m-sg-owner-ack").checked) { showErr("m-sg-form-err", new Error("Tick the box to confirm you have read the warnings.")); $("m-sg-owner-ack").focus(); return; }
      signersRun(`/api/users/${user.id}/safe/owners`, { address, acknowledged: true }, "m-sg-form-err", $("m-sg-owner-go"));
    };
  }

  if (signersView === "lock") {
    const blocked = !s.guardians ? "No recovery guardian is on this account, so a locked account could never be reset. Set up recovery first." : "";
    el.innerHTML = `
      <div class="m-h1" style="font-size:24px">Require the second owner</div>
      <div class="m-note warn" role="note"><span class="material-symbols-rounded" aria-hidden="true">lock</span>
        <div>Every transaction will need both your passkey <em>and</em> ${second ? sgAddr(second.address) : "the second owner"}. Zold can collect only the passkey's signature, and your passkey does not work on app.safe.global.
        <strong>From Zold and from app.safe.global alike, nothing can be signed afterwards</strong> — sending, converting and changing this setting back all stop.
        The only way back is a recovery, which also removes the second owner.</div></div>
      ${blocked ? `<div class="m-err" role="alert" style="margin-top:12px">${esc(blocked)}</div>` : `
      <div class="m-field" style="margin-top:16px"><label for="m-sg-lock-phrase">Type ${esc(s.lockPhrase)} to confirm</label>
        <input id="m-sg-lock-phrase" name="lock-confirmation" autocomplete="off" spellcheck="false" autocapitalize="characters" translate="no" /></div>
      <button class="m-cta" id="m-sg-lock-go" type="button" style="background:var(--m-amber);color:#1a1206">Sign with Passkey to Lock</button>`}
      <div class="m-err hidden" id="m-sg-form-err" role="alert" style="margin-top:12px"></div>
      ${back}`;
    const go = $("m-sg-lock-go");
    if (go) go.onclick = () => {
      const confirmText = $("m-sg-lock-phrase").value.trim();
      if (confirmText !== s.lockPhrase) { showErr("m-sg-form-err", new Error(`Type ${s.lockPhrase} exactly to confirm.`)); $("m-sg-lock-phrase").focus(); return; }
      signersRun(`/api/users/${user.id}/safe/threshold`, { threshold: s.owners.length, confirm: confirmText }, "m-sg-form-err", go);
    };
  }

  if (signersView === "limit") {
    el.innerHTML = `
      <div class="m-h1" style="font-size:24px">Allow someone to spend from your account</div>
      <span class="m-tag">ADVANCED</span>
      <div class="m-lede" style="font-size:13px;margin-top:8px">This person can spend up to the limit you set without your signature, through Safe's Allowance module. They spend it with their own wallet at app.safe.global, under Spending limits. Zold does not move it for them. You can remove the limit here at any time; a recovery does not remove it.</div>
      <div class="m-field" style="margin-top:16px"><label for="m-sg-lim-delegate">Their wallet address</label>
        <input id="m-sg-lim-delegate" name="delegate-address" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="0x…" translate="no" value="${esc(second?.address || "")}" /></div>
      <div class="m-field" style="margin-top:12px"><label for="m-sg-lim-token">Token</label>
        <select id="m-sg-lim-token" name="token" style="width:100%;background:var(--m-surface);color:#fff;border:0;padding:8px 0;font:inherit">
          ${s.tokens.map((t) => `<option value="${esc(t.address)}">${esc(t.symbol)}</option>`).join("")}</select></div>
      <div class="m-field" style="margin-top:12px"><label for="m-sg-lim-amount">Amount</label>
        <input id="m-sg-lim-amount" name="limit-amount" autocomplete="off" inputmode="decimal" placeholder="100.00…" /></div>
      <div class="m-field" style="margin-top:12px"><label for="m-sg-lim-period">Refills</label>
        <select id="m-sg-lim-period" name="period" style="width:100%;background:var(--m-surface);color:#fff;border:0;padding:8px 0;font:inherit">
          <option value="day">Every day</option><option value="week">Every week</option><option value="month">Every 30 days</option><option value="once">Never (one-time)</option></select></div>
      ${sgAckBox("m-sg-lim-ack", "I understand this person can spend up to this limit without my passkey, and that a recovery does not remove it.")}
      <button class="m-cta" id="m-sg-lim-go" type="button">Sign with passkey to allow</button>
      <div class="m-err hidden" id="m-sg-form-err" role="alert" style="margin-top:12px"></div>
      ${back}`;
    $("m-sg-lim-go").onclick = () => {
      const delegate = $("m-sg-lim-delegate").value.trim();
      const amount = $("m-sg-lim-amount").value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(delegate)) { showErr("m-sg-form-err", new Error("Enter their wallet's 0x address.")); $("m-sg-lim-delegate").focus(); return; }
      if (!(Number(amount.replace(",", ".")) > 0)) { showErr("m-sg-form-err", new Error("Enter an amount above zero, e.g. 100.")); $("m-sg-lim-amount").focus(); return; }
      if (!$("m-sg-lim-ack").checked) { showErr("m-sg-form-err", new Error("Tick the box to confirm you have read the warning.")); $("m-sg-lim-ack").focus(); return; }
      signersRun(`/api/users/${user.id}/safe/spending-limits`, {
        delegate, amount, token: $("m-sg-lim-token").value, period: $("m-sg-lim-period").value, acknowledged: true,
      }, "m-sg-form-err", $("m-sg-lim-go"));
    };
  }

  $("m-sg-back").onclick = () => { signersView = "main"; renderSignersScreen(); };
}
