/**
 * The guardian step of a recovery on /recovery. For Google/Apple, back from
 * the login: a
 * Turnkey session for the guardian's sub-org bound to the browser key, the
 * digest the API recomputed from the module, Turnkey signs it with that key,
 * the API checks and relays it, and the key is dropped whatever happens.
 *
 * No DOM; scripts/turnkey-guardian-page-test.ts runs it with stand-ins.
 */
import { OAUTH_STATE_KEY, readReturn } from "../guardian/oauth.js";
import { signRawPayload } from "../guardian/turnkey-sign.js";

/**
 * Returns {step: "approved", request} or {step: "error", reason}; null when
 * there is no login to handle.
 */
export async function finishApprove(env) {
  const { hash, storage, stripHash, stamper, api, now = Date.now } = env;
  stripHash();
  let storedState = null;
  try {
    storedState = storage.getItem(OAUTH_STATE_KEY);
    storage.removeItem(OAUTH_STATE_KEY);
  } catch {
    // Storage blocked: no state to match, so readReturn refuses the login.
  }
  const back = readReturn(hash, storedState, now());
  if (!back) return null;
  if (!back.ok) {
    await stamper.clear().catch(() => {});
    return { step: "error", reason: back.reason };
  }
  return approveWith({ ...env, login: async () => {
    await stamper.init();
    const publicKey = stamper.getPublicKey();
    if (!publicKey) throw new Error("That login timed out in this browser. Try again.");
    return api("/api/recovery/turnkey/login", { oidcToken: back.idToken, publicKey });
  } });
}

/**
 * Any guardian login, then the same three steps: the API's digest, the
 * guardian's signature from Turnkey (stamped by `stamper`: the browser key
 * for Google, Apple or email, the passkey itself for a passkey), and the API
 * checks and relays it. `login()` answers {subOrgId, address}.
 */
export async function approveWith({ stamper, login, api, recovery, turnkeyApi, sign = signRawPayload }) {
  const withSecret = { "x-recovery-secret": recovery.secret };
  const path = (suffix = "") => `/api/recovery/turnkey/requests/${encodeURIComponent(recovery.requestId)}${suffix}`;
  try {
    const who = await login();
    const { digest } = await api(path("/digest"), undefined, withSecret);
    // A pending activity is read through the API: polled with a passkey's
    // stamper, every poll would be another prompt.
    const pollActivity = (activityId) => api(path(`/activity/${encodeURIComponent(activityId)}`), undefined, withSecret);
    const signature = await sign({ stamper, baseUrl: turnkeyApi, organizationId: who.subOrgId, signWith: who.address, payload: digest, pollActivity });
    const request = await api(path("/signature"), signature, withSecret);
    return { step: "approved", request };
  } catch (e) {
    if (e?.code === "WRONG_SIGNER") return { step: "error", reason: "That’s a different login from your backup login. Use the one you set up." };
    if (e?.code === "NO_GUARDIAN") return { step: "error", reason: "That isn’t your backup login. Use the one you set up." };
    return { step: "error", reason: e?.name === "NotAllowedError" ? "The passkey prompt was cancelled. Try again." : e.message };
  } finally {
    await stamper.clear?.().catch(() => {});
  }
}
