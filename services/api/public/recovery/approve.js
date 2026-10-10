/**
 * The Google/Apple step of a recovery, back from the login on /recovery: a
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
  const { hash, storage, stripHash, stamper, api, recovery, turnkeyApi, sign = signRawPayload, now = Date.now } = env;
  const storedState = storage.getItem(OAUTH_STATE_KEY);
  storage.removeItem(OAUTH_STATE_KEY);
  stripHash();
  const back = readReturn(hash, storedState, now());
  if (!back) return null;
  const withSecret = { "x-recovery-secret": recovery.secret };
  const path = (suffix = "") => `/api/recovery/turnkey/requests/${encodeURIComponent(recovery.requestId)}${suffix}`;
  try {
    if (!back.ok) return { step: "error", reason: back.reason };
    await stamper.init();
    const publicKey = stamper.getPublicKey();
    if (!publicKey) return { step: "error", reason: "That login timed out in this browser. Try again." };
    const login = await api("/api/recovery/turnkey/login", { oidcToken: back.idToken, publicKey });
    const toSign = await api(path("/digest"), undefined, withSecret);
    if (login.subOrgId !== toSign.subOrgId) {
      return { step: "error", reason: "That’s a different Google or Apple account. Log in with your backup login." };
    }
    const signature = await sign({ stamper, baseUrl: turnkeyApi, organizationId: login.subOrgId, signWith: toSign.guardianAddress, payload: toSign.digest });
    const request = await api(path("/signature"), signature, withSecret);
    return { step: "approved", request };
  } catch (e) {
    return { step: "error", reason: e.message };
  } finally {
    await stamper.clear().catch(() => {});
  }
}
