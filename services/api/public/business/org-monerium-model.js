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
 *  `issue` for an owner who can sign, `check` while Monerium works on it. */
export function ibanPanel(m, maySign) {
  const st = ibanState(m);
  if (st === null) return { text: "The IBAN status couldn’t be read. Open Settings again to retry." };
  if (st === "issued") return { text: "Bank transfers to this IBAN arrive on the company’s Safe as euros (EURe). Paying a bank account from it is not built yet.", iban: m.companyIban.iban, action: "check" };
  if (st === "keys_needed") return { text: "Next: once Monerium has approved the company profile, an owner issues the company’s IBAN onto its own Safe." };
  if (st === "safe_needed") return { text: "Next: set up the company’s Safe (Home), then issue its IBAN here." };
  if (st === "link_pending") return { text: "Monerium is checking the Safe’s signed declaration. Check again in a minute.", action: "check" };
  if (st === "iban_requested") return { text: "The IBAN is requested. Monerium usually issues it within minutes. Check again shortly.", action: "check" };
  return maySign
    ? { text: "Your passkey signs Monerium’s declaration that the company owns its Safe. Monerium then issues the company’s IBAN onto the Safe.", action: "issue" }
    : { text: "An owner of the company signs Monerium’s declaration with their passkey to issue the IBAN." };
}

/** The toast after issuing or checking: where the IBAN has got. */
export function ibanNotice(m) {
  const st = ibanState(m);
  if (st === "issued") return "The company’s IBAN is issued onto its Safe.";
  if (st === "link_pending") return "Signed. Monerium is checking the declaration; check again in a minute.";
  if (st === "iban_requested") return "IBAN requested. Monerium usually issues it within minutes.";
  return "Nothing new from Monerium yet.";
}
