/**
 * A company org's own Monerium keys, without the DOM: what Settings and
 * Home's set-up card say about GET /api/orgs/:id/monerium. The keys connect
 * the company's Monerium account; issuing the IBAN onto the company's Safe
 * is not built yet, so that step is never offered as an action.
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

/** Home's company set-up: the keys step, then the IBAN step that is not
 *  live. `m` null is an unread status: "couldn't check", never "not done". */
export function companySteps(m) {
  return [
    { id: "companyMonerium", done: m ? m.status === "connected" : null },
    { id: "companyIban", done: false, notLive: true },
  ];
}
