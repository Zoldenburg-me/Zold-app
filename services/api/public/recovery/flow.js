/**
 * The lost-device flow on /recovery, without the DOM: which guardian a
 * recovery goes through, where its request lives, and which screen its state
 * belongs on. scripts/turnkey-guardian-page-test.ts runs it.
 *
 * Guardians are tried in turn — email/SMS codes (Candide), Zoldenburg, then
 * the person's own Google or Apple login (Turnkey); an account without one
 * answers 404 and the next is asked.
 *
 * The per-request secret the API hands out once is what lets THIS browser
 * drive the request; it is kept per email in localStorage (same keys /app
 * used, so a recovery started there resumes here).
 */
export const SECRET_KEY = "zold-recovery-secret";
export const TICKET_KEY = "zold-recovery-otp-ticket";
/** The email of the recovery in progress in this tab, to resume after a reload or a login redirect. */
export const EMAIL_KEY = "zold-recovery-email";

/** The user handle of the recovery passkey made in this browser. Kept until
 *  the API accepts that passkey: an authenticator replaces its own passkey for
 *  the same handle, so a retry does not leave one more on a security key's few
 *  slots. Once accepted it is the account's owner, and a later recovery must not replace it. */
export const HANDLE_KEY = "zold-recovery-passkey-handle";

/** This recovery's passkey user handle (base64url, 16 random bytes): the saved one, or a new one saved. */
export function recoveryHandle(storage, email, random = () => crypto.getRandomValues(new Uint8Array(16))) {
  const saved = savedFor(storage, HANDLE_KEY, email);
  if (saved) return saved;
  const made = btoa(String.fromCharCode(...random())).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  saveFor(storage, HANDLE_KEY, email, made);
  return made;
}

/** The submit's answer: a request past PASSKEY_PENDING owns that passkey, so forget its handle
 *  (the server sweep can finalise the recovery without this page seeing "done"). */
export function passkeySubmitted(storage, email, request) {
  if (request?.status !== "PASSKEY_PENDING") saveFor(storage, HANDLE_KEY, email, "");
  return request;
}

export function savedFor(storage, key, email) {
  try { return JSON.parse(storage.getItem(key) || "{}")[email.toLowerCase()] || ""; } catch { return ""; }
}
export function saveFor(storage, key, email, value) {
  try {
    const all = JSON.parse(storage.getItem(key) || "{}");
    if (value) all[email.toLowerCase()] = value; else delete all[email.toLowerCase()];
    storage.setItem(key, JSON.stringify(all));
  } catch { /* private mode: the recovery still works in this tab */ }
}

/** The guardians this deployment offers, in the order they are tried. */
export function routesFor(caps) {
  return [
    { mode: "candide", path: "/api/recovery/candide", on: caps?.emailSmsRecovery },
    { mode: "zoldenburg", path: "/api/recovery/zoldenburg", on: caps?.zoldenburgRecovery },
    { mode: "turnkey", path: "/api/recovery/turnkey/requests", on: caps?.turnkeyGuardians },
  ].filter((r) => r.on).map(({ mode, path }) => ({ mode, path }));
}

/** A request's API path; Turnkey requests live under /requests. */
export const requestPath = (mode, id, suffix = "") =>
  mode === "turnkey" ? `/api/recovery/turnkey/requests/${id}${suffix}` : `/api/recovery/${mode}/${id}${suffix}`;

/** Start (or resume, with the saved secret) through the first guardian the account has. */
export async function startRecovery(email, { api, caps, secret }) {
  const routes = routesFor(caps);
  if (!routes.length) throw new Error("Account recovery isn’t available right now.");
  const body = { email, ...(secret ? { recoverySecret: secret } : {}) };
  for (const [i, { mode, path }] of routes.entries()) {
    try {
      return { mode, request: await api(path, body) };
    } catch (e) {
      if (!(e?.status === 404 && i < routes.length - 1)) throw e;
    }
  }
  throw new Error("unreachable");
}

const ZOLD_REVIEW = ["KYC_PENDING", "REVIEW_PENDING", "DELAYING", "READY_FOR_GUARDIAN", "GUARDIAN_SUBMITTED"];

/** The screen a request's state belongs on; "email" when it cannot go on. */
export function screenFor(mode, r) {
  if (!r) return "email";
  if (r.status === "PASSKEY_PENDING") return "passkey";
  if (r.status === "OTP_PENDING") return "codes";
  if (r.status === "GRACE_PERIOD") return "wait";
  if (r.status === "FINALIZED") return "done";
  if (mode === "zoldenburg" && ZOLD_REVIEW.includes(r.status)) return "zoldenburg";
  if (mode === "turnkey" && r.status === "REVIEW_PENDING") return "approve";
  return "email";
}

/** One sentence for a request that cannot go on, shown on the email step. */
export function endedText(r) {
  if (r.status === "CANCELED") return "This recovery was stopped, most likely from your old phone. Start again if you still need to.";
  if (r.status === "EXPIRED") return "This recovery timed out before it finished. Start again.";
  return r.error || "This recovery can’t continue. Start again.";
}

/** When the waiting period ends, whichever guardian ran it. */
export function finalizeAfter(r) {
  const iso = r?.candide?.finalizeAfter || r?.zoldenburg?.finalizeAfter || r?.turnkey?.finalizeAfter;
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** The code channel asked for now: the first one not confirmed. */
export const currentAuth = (r) => (r?.candide?.auths || []).findIndex((a) => !a.verified);
