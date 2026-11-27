/**
 * A company org's own Monerium keys, without the DOM: what Settings and
 * Home's set-up card say about GET /api/orgs/:id/monerium. The keys connect
 * the company's Monerium account; an owner's passkey then signs Monerium's
 * declaration for the company Safe, and Monerium issues the IBAN onto it
 * (routes/business/org-monerium-iban.ts, `companyIban`).
 *
 * No imports, so scripts/org-monerium-test.ts loads it in node.
 */

/** Is this the org whose Monerium keys are its own (a company), and may
 *  this member manage them (accounts.open: owners and admins)? */
export const companyKeysHere = (org, mayManage) => org?.type === "business" && org.entity === "company" && !!mayManage;

export const STATUS_WORD = {
  not_connected: "Not connected",
  pending: "Waiting for Monerium",
  connected: "Connected",
  invalid: "Needs new keys",
};

const ENV_WORD = { sandbox: "Sandbox (test money)", production: "Production (real money)", custom: "Custom" };

/** The rows Settings shows; empty values are dropped by the caller. */
export function keyRows(m) {
  if (!m) return [["Status", "Couldn’t check"]];
  return [
    ["Status", STATUS_WORD[m.status] || m.status],
    ["Environment", ENV_WORD[m.environment] || m.environment],
    ["Company profile", m.profile?.name ? `${m.profile.name} (${m.profile.state})` : m.profile?.state || ""],
    ["App id", m.clientId || ""],
  ];
}

/** One line on what happens next, or "" when there is nothing to say. */
export function keyHint(m) {
  if (!m) return "The Monerium keys couldn’t be read. Open Settings again to retry.";
  if (m.status === "not_connected") return m.available ? "" : `Not available here: ${m.needs || "the server can’t store keys"}.`;
  if (m.status === "pending") return `Monerium hasn’t approved the company profile yet (it is ${m.profile?.state || "in review"}). Check again once they have.`;
  if (m.status === "invalid") {
    if (m.rejectedAt) return "Monerium no longer accepts these keys. Connect new keys from the company’s Monerium account.";
    if (m.profileMissingAt) return "These keys no longer open the company profile they were connected with. Connect the company’s current keys.";
    return `Monerium has ${m.profile?.state || "closed"} the company profile. Connect keys from an approved company profile.`;
  }
  return "";
}

/** The toast after saving or checking the keys: what the status now is. */
export function keyNotice(m, verb) {
  if (m?.status === "connected") return verb === "check" ? "Checked: connected." : "Monerium keys connected.";
  const hint = keyHint(m);
  return verb === "check" ? `Checked. ${hint}` : `Monerium keys saved. ${hint}`;
}

/** Home's company set-up: the keys step, then the IBAN step. `m` null is an
 *  unread status: "couldn't check", never "not done". The IBAN is done only
 *  once Monerium attributed it to the Safe. */
export function companySteps(m) {
  const iban = ibanState(m);
  return [
    { id: "companyMonerium", done: m ? m.status === "connected" || iban === "issued" : null },
    { id: "companyIban", done: m ? iban === "issued" : null, state: iban },
  ];
}

/** The IBAN step's state (domain/org-monerium-iban.ts), or null unread. */
export const ibanState = (m) => (m ? m.companyIban?.state || "keys_needed" : null);

/** What the IBAN part of Settings → Monerium says, and which button it offers:
 *  `issue` for an owner who can sign, `check` while Monerium works on it.
 *  `payoutsOn` is capabilities().orgBankPayouts: a deployment may switch the
 *  company bank payout off, and then the IBAN says so instead of pointing at
 *  a form that is not drawn. */
export function ibanPanel(m, maySign, payoutsOn = false) {
  const st = ibanState(m);
  if (st === null) return { text: "The IBAN status couldn’t be read. Open Settings again to retry." };
  // Checking an issued IBAN reads Monerium on the company's keys: offered only while they are connected.
  if (st === "issued") return {
    text: payoutsOn
      ? "Bank transfers to this IBAN arrive on the company’s Safe as euros (EURe). An owner can pay a bank account from it below, or send a bank payment saved in New payment from Payments."
      : "Bank transfers to this IBAN arrive on the company’s Safe as euros (EURe). Paying a bank account from it is switched off on this deployment.",
    iban: m.companyIban.iban,
    ...(m.status !== "not_connected" ? { action: "check" } : {}),
  };
  if (st === "moved") return { text: "Monerium now lists the company’s IBAN on another address or network, so Zold no longer offers it for the Safe. Write to support@zoldhq.com.", action: "check" };
  if (st === "keys_needed") return { text: "Next: once Monerium has approved the company profile, an owner issues the company’s IBAN onto its own Safe." };
  if (st === "safe_needed") return { text: "Next: set up the company’s Safe (Home), then issue its IBAN here." };
  if (st === "link_pending") return { text: "Monerium is checking the Safe’s signed declaration. Check again in a minute.", action: "check" };
  if (st === "iban_requested") return { text: "The IBAN is requested. Monerium usually issues it within minutes. Check again shortly.", action: "check" };
  return maySign
    ? { text: "Your passkey signs Monerium’s declaration that the company owns its Safe. Monerium then issues the company’s IBAN onto the Safe.", action: "issue" }
    : { text: "An owner of the company signs Monerium’s declaration with their passkey to issue the IBAN." };
}

/** What a payout's stored state says (routes/business/org-monerium-payouts.ts).
 *  `pending` is Monerium holding the order, not money gone; `unknown` must
 *  never read as sent. */
export const PAYOUT_STATE_WORD = {
  pending: "Pending at Monerium",
  sent: "Sent",
  failed: "Not sent",
  unknown: "Unclear: check Monerium",
};

/** The toast after a payout is started or submitted. */
export function payoutNotice(p) {
  const st = p?.state;
  if (st === "sent") return "Sent: Monerium processed the payout.";
  if (st === "pending") return "Monerium has the payout. It is not sent until Monerium processes it.";
  if (st === "failed") return "Not sent. Monerium refused the payout.";
  if (st === "unknown") return "Unclear: Monerium did not confirm the payout. Check Monerium before sending it again.";
  return "Payout started.";
}

/** What a company bank run did, after the owner signed it
 *  (routes/business/org-monerium-bank-runs.ts). `view` is the draft as the
 *  API returns it, with `bankRun.lines`. Placed is never said as sent: a line
 *  is sent once Monerium processes it. */
export function bankRunNotice(view) {
  const lines = view?.bankRun?.lines || [];
  const n = lines.length;
  if (!n) return { text: "The payment run was not sent.", error: true };
  if (lines.every((l) => l.state === "sent")) return { text: `Sent: Monerium processed all ${n} bank payment${n === 1 ? "" : "s"}.` };
  const stopped = lines.some((l) => ["failed", "unknown", "not_sent"].includes(l.state));
  if (!stopped) {
    return { text: `Monerium has ${n} bank payment${n === 1 ? "" : "s"}. They are not sent until Monerium processes them; each is booked then.` };
  }
  const unclear = lines.some((l) => l.state === "unknown");
  return {
    text: `${unclear ? "The run stopped at a payment Monerium did not confirm." : "The run stopped at a payment Monerium did not accept."} ${view.failureReason || ""}`.trim(),
    error: true,
  };
}

/** The payouts Settings lists, newest first: a line each, with the state in
 *  words and, when there is one, the fixed reason. The recipient IBAN is shown
 *  masked to its last four characters. */
export function payoutRows(payouts) {
  return (payouts || []).map((p) => ({
    id: p.id,
    title: `€${Number(p.amountEur).toFixed(2)} to ${p.recipientName}`,
    sub: `•••• ${String(p.recipientIban || "").replace(/\s+/g, "").slice(-4)}${p.reference ? ` · ${p.reference}` : ""} · ${String(p.createdAt || "").slice(0, 10)}`,
    state: PAYOUT_STATE_WORD[p.state] || p.state,
    bad: p.state === "failed" || p.state === "unknown",
    note: p.error || "",
  }));
}

/** The toast after issuing or checking: where the IBAN has got. */
export function ibanNotice(m) {
  const st = ibanState(m);
  if (st === "issued") return "The company’s IBAN is issued onto its Safe.";
  if (st === "moved") return "Monerium lists the company’s IBAN elsewhere now. It is no longer offered for the Safe.";
  if (st === "link_pending") return "Signed. Monerium is checking the declaration; check again in a minute.";
  if (st === "iban_requested") return "IBAN requested. Monerium usually issues it within minutes.";
  return "Nothing new from Monerium yet.";
}
