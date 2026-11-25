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

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** This recovery's passkey user handle (base64url, 16 random bytes): the saved one, or a new one saved. */
export function recoveryHandle(storage, email, random = () => crypto.getRandomValues(new Uint8Array(16))) {
  const saved = savedFor(storage, HANDLE_KEY, email);
  if (saved) return saved;
  const made = b64url(random());
  saveFor(storage, HANDLE_KEY, email, made);
  return made;
}

export const STILL_CHECKING = "Your passkey is still being checked. Wait a moment, then try again.";

/** The id of the request whose passkey submit has no definite answer yet. The
 *  server may have accepted that passkey with the answer lost on the way back;
 *  a new ceremony with the same handle would then make a security key replace
 *  the accepted passkey with one the server refuses. */
export const SUBMIT_KEY = "zold-recovery-passkey-submit";

/** The submit's answer: a request past PASSKEY_PENDING owns that passkey, so forget its handle
 *  (the server sweep can finalise the recovery without this page seeing "done"). */
export function passkeySubmitted(storage, email, request) {
  if (request?.status !== "PASSKEY_PENDING") {
    saveFor(storage, HANDLE_KEY, email, "");
    saveFor(storage, SUBMIT_KEY, email, "");
  }
  return request;
}

/** Make the recovery passkey and submit it. After a submit with no definite
 *  answer the same request is read back first: past PASSKEY_PENDING, that
 *  passkey was accepted and the recovery goes on with no new ceremony; a read
 *  that fails throws, still unresolved. Only a refusal that leaves the request
 *  waiting (a 4xx but 409, which says it moved on) lets the handle be reused at once.
 *  `create(handle)` runs the ceremony, `read(request)` and `submit(request, body)` call the API. */
export async function submitPasskey(storage, email, request, { create, read, submit }) {
  if (savedFor(storage, SUBMIT_KEY, email) === request.id) {
    const now = await read(request);
    if (now?.status !== "PASSKEY_PENDING") return passkeySubmitted(storage, email, now);
    // The first submit is still waiting on the guardian: a new ceremony now
    // would replace the passkey it is about to record.
    if (now.passkeySubmitting) throw new Error(STILL_CHECKING);
    saveFor(storage, SUBMIT_KEY, email, "");
  }
  const body = await create(recoveryHandle(storage, email));
  // Candide's OTP ticket: made and kept here before the submit, so an answer
  // lost on the way back does not lose it (the server returns it only then).
  if (request.mode === "candide") {
    body.otpTicket = b64url(crypto.getRandomValues(new Uint8Array(32)));
    saveFor(storage, TICKET_KEY, email, body.otpTicket);
  }
  saveFor(storage, SUBMIT_KEY, email, request.id);
  let answer;
  try {
    answer = await submit(request, body);
  } catch (e) {
    if (e?.status >= 400 && e.status < 500 && e.status !== 409) saveFor(storage, SUBMIT_KEY, email, "");
    throw e;
  }
  saveFor(storage, SUBMIT_KEY, email, "");
  return passkeySubmitted(storage, email, answer);
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
