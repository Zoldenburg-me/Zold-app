/**
 * The operator's passkey ceremonies, under /api/admin/auth. The operator gate
 * (operators/gate.ts) runs first: Cloudflare Access applies to every one of
 * them, a session to all but login and enrolment, and a fresh approval to
 * adding a passkey.
 *
 * Every assertion and registration is verified against the admin origin
 * only, under purposes no user ceremony uses, so neither a user passkey nor
 * a script on the user app can stand in for the operator.
 */
import express from "express";
import { randomBytes } from "node:crypto";
import { OPERATOR, SECURITY } from "../config.js";
import { auditEntry } from "../audit.js";
import { redactedMessage } from "../http/log-cause.js";
import { clientKey, forgetFailure, recordFailure, tooManyFailures } from "../http/policy.js";
import { accessRequired } from "../operators/access.js";
import { endEnrolment, enrolmentFor } from "../operators/enrolment.js";
import { accessEmailOf, operatorOf } from "../operators/principal.js";
import { issueOperatorSession } from "../operators/sessions.js";
import { operatorStepUpBinding } from "../operators/step-up.js";
import { store } from "../store.js";
import type { Operator, OperatorCredential } from "../store/types.js";
import { bufToB64url, issueChallenge, verifyAssertion, verifyRegistration } from "../webauthn.js";

const LOGIN_FAILURES_MAX = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
const CHANGE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** With Access in front, the person it signed in must be this operator. */
function accessAllows(req: express.Request, email: string): boolean {
  if (!accessRequired()) return true;
  return accessEmailOf(req) === email.trim().toLowerCase();
}

function creationOptions(challenge: string, userId: string, name: string, email: string, exclude: string[]) {
  return {
    challenge,
    rp: { id: SECURITY.rpId, name: "Zold operator" },
    user: { id: bufToB64url(Buffer.from(userId)), name: email, displayName: name },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: exclude.map((id) => ({ type: "public-key", id })),
    timeout: 120_000,
  };
}

function label(raw: unknown, fallback: string): string {
  const v = typeof raw === "string" ? raw.trim().slice(0, 60) : "";
  return v || fallback;
}

const publicOperator = (o: Operator) => ({
  id: o.id,
  name: o.name,
  email: o.email,
  passkeys: o.credentials.map((c) => ({ label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
});

export function createOperatorAuthRouter() {
  const router = express.Router();

  router.post("/admin/auth/enrol/challenge", (req, res) => {
    const e = enrolmentFor(req.body?.token);
    if ("refused" in e) return res.status(403).json({ error: e.refused, code: "ENROLMENT_REFUSED" });
    if (!accessAllows(req, e.email)) {
      return res.status(403).json({ error: "signed in to Cloudflare Access as someone other than the person being enrolled", code: "ACCESS_MISMATCH" });
    }
    const existing = store.findOperatorByEmail(e.email);
    const challenge = issueChallenge("operator_enrol", `op:enrol:${e.id}`);
    res.json(creationOptions(challenge, existing?.id ?? e.id, e.name, e.email, existing?.credentials.map((c) => c.credentialId) ?? []));
  });

  router.post("/admin/auth/enrol", (req, res) => {
    const e = enrolmentFor(req.body?.token);
    if ("refused" in e) return res.status(403).json({ error: e.refused, code: "ENROLMENT_REFUSED" });
    if (!accessAllows(req, e.email)) {
      return res.status(403).json({ error: "signed in to Cloudflare Access as someone other than the person being enrolled", code: "ACCESS_MISMATCH" });
    }
    let reg: ReturnType<typeof verifyRegistration>;
    try {
      reg = verifyRegistration(req.body?.attestationObject, req.body?.clientDataJSON, SECURITY.rpId, [OPERATOR.adminOrigin], `op:enrol:${e.id}`, "operator_enrol");
    } catch (err) {
      return res.status(400).json({ error: redactedMessage(err, { keepHosts: true }), code: "REGISTRATION_INVALID" });
    }
    const existing = store.findOperatorByEmail(e.email);
    if (existing?.disabledAt) return res.status(403).json({ error: "this operator is disabled", code: "OPERATOR_DISABLED" });
    if (existing && existing.credentials.length >= OPERATOR.maxPasskeys) {
      return res.status(409).json({ error: `an operator holds at most ${OPERATOR.maxPasskeys} passkeys`, code: "PASSKEY_LIMIT" });
    }
    if (store.findOperatorCredential(reg.credentialId)) {
      return res.status(409).json({ error: "that passkey is already registered", code: "PASSKEY_EXISTS" });
    }
    const now = new Date().toISOString();
    const operator = existing ?? store.addOperator({
      id: `op_${randomBytes(8).toString("hex")}`, name: e.name, email: e.email, createdAt: now, credentials: [],
    });
    const credential: OperatorCredential = {
      credentialId: reg.credentialId, key: reg.key, signCount: reg.signCount, label: label(req.body?.label, "Passkey"), createdAt: now,
    };
    store.addOperatorCredential(operator.id, credential);
    // The link is used: nothing awaits between the check above and this.
    endEnrolment();
    store.audit(auditEntry("operator.enrolled", { operator: `operator:${operator.id}`, operatorName: operator.name, passkey: credential.label }));
    res.json({ sessionToken: issueOperatorSession(operator.id), operator: publicOperator(store.findOperator(operator.id)!) });
  });

  router.post("/admin/auth/login/challenge", (req, res) => {
    // Behind Access, only the signed-in person's passkeys are offered.
    const email = accessEmailOf(req);
    const operators = store.operators.filter((o) => !o.disabledAt && (email === undefined || o.email === email));
    res.json({
      challenge: issueChallenge("operator_login"),
      rpId: SECURITY.rpId,
      allowCredentials: operators.flatMap((o) => o.credentials.map((c) => ({ type: "public-key", id: c.credentialId }))),
      userVerification: "required",
      timeout: 120_000,
    });
  });

  router.post("/admin/auth/login", async (req, res) => {
    const key = `oplogin:${clientKey(req.ip)}`;
    if (tooManyFailures(key, LOGIN_FAILURES_MAX)) {
      return res.status(429).json({ error: "too many failed sign-ins: wait fifteen minutes", code: "LOGIN_LOCKED" });
    }
    recordFailure(key, LOGIN_FAILURE_WINDOW_MS);
    const b = req.body ?? {};
    const found = typeof b.credentialId === "string" ? store.findOperatorCredential(b.credentialId) : undefined;
    if (!found || found.operator.disabledAt) return res.status(401).json({ error: "that passkey is not an operator's", code: "LOGIN_REFUSED" });
    const { operator, credential } = found;
    if (!accessAllows(req, operator.email)) {
      return res.status(403).json({ error: "signed in to Cloudflare Access as someone other than this operator", code: "ACCESS_MISMATCH" });
    }
    let signCount: number;
    try {
      ({ signCount } = await verifyAssertion(
        b.authenticatorData, b.clientDataJSON, b.signature, credential.key, credential.signCount,
        SECURITY.rpId, [OPERATOR.adminOrigin], "operator_login",
      ));
    } catch (err) {
      return res.status(401).json({ error: redactedMessage(err, { keepHosts: true }), code: "LOGIN_REFUSED" });
    }
    forgetFailure(key);
    store.recordOperatorCredentialUse(operator.id, credential.credentialId, signCount);
    store.audit(auditEntry("operator.signed_in", { operator: `operator:${operator.id}`, operatorName: operator.name, passkey: credential.label }));
    res.json({ sessionToken: issueOperatorSession(operator.id), operator: publicOperator(operator) });
  });

  /** A challenge bound to one change: method, path and body. The client sends
   *  the same body to this route and to the change itself. */
  router.post("/admin/auth/step-up/challenge", (req, res) => {
    const who = operatorOf(req);
    const operator = who ? store.findOperator(who.id) : undefined;
    if (!operator) return res.status(401).json({ error: "operator sign-in required", code: "OPERATOR_SIGN_IN" });
    const method = String(req.body?.method ?? "").toUpperCase();
    const path = String(req.body?.path ?? "");
    if (!CHANGE_METHODS.has(method)) return res.status(400).json({ error: "method must be POST, PUT, PATCH or DELETE" });
    if (!/^\/api\/admin\//i.test(path) || path.includes("?")) return res.status(400).json({ error: "path must be an /api/admin path without a query" });
    res.json({
      challenge: issueChallenge("operator_step_up", operatorStepUpBinding(operator.id, method, path, req.body?.body)),
      rpId: SECURITY.rpId,
      allowCredentials: operator.credentials.map((c) => ({ type: "public-key", id: c.credentialId })),
      userVerification: "required",
      timeout: 120_000,
    });
  });

  router.post("/admin/auth/passkeys/challenge", (req, res) => {
    const who = operatorOf(req);
    const operator = who ? store.findOperator(who.id) : undefined;
    if (!operator) return res.status(401).json({ error: "operator sign-in required", code: "OPERATOR_SIGN_IN" });
    const challenge = issueChallenge("operator_enrol", `op:add:${operator.id}`);
    res.json(creationOptions(challenge, operator.id, operator.name, operator.email, operator.credentials.map((c) => c.credentialId)));
  });

  /** Adding a passkey is a change: the gate has already checked a fresh
   *  approval from one of the operator's existing passkeys. */
  router.post("/admin/auth/passkeys", (req, res) => {
    const who = operatorOf(req);
    const operator = who ? store.findOperator(who.id) : undefined;
    if (!operator) return res.status(401).json({ error: "operator sign-in required", code: "OPERATOR_SIGN_IN" });
    if (operator.credentials.length >= OPERATOR.maxPasskeys) {
      return res.status(409).json({ error: `an operator holds at most ${OPERATOR.maxPasskeys} passkeys`, code: "PASSKEY_LIMIT" });
    }
    let reg: ReturnType<typeof verifyRegistration>;
    try {
      reg = verifyRegistration(req.body?.attestationObject, req.body?.clientDataJSON, SECURITY.rpId, [OPERATOR.adminOrigin], `op:add:${operator.id}`, "operator_enrol");
    } catch (err) {
      return res.status(400).json({ error: redactedMessage(err, { keepHosts: true }), code: "REGISTRATION_INVALID" });
    }
    if (store.findOperatorCredential(reg.credentialId)) {
      return res.status(409).json({ error: "that passkey is already registered", code: "PASSKEY_EXISTS" });
    }
    const credential: OperatorCredential = {
      credentialId: reg.credentialId, key: reg.key, signCount: reg.signCount,
      label: label(req.body?.label, `Passkey ${operator.credentials.length + 1}`), createdAt: new Date().toISOString(),
    };
    store.addOperatorCredential(operator.id, credential);
    store.audit(auditEntry("operator.passkey_added", { operator: `operator:${operator.id}`, operatorName: operator.name, passkey: credential.label }));
    res.json({ operator: publicOperator(store.findOperator(operator.id)!) });
  });

  router.post("/admin/auth/logout", (req, res) => {
    const who = operatorOf(req);
    if (who) store.revokeOperatorSession(who.sessionId);
    res.json({ ok: true });
  });

  router.get("/admin/auth/me", (req, res) => {
    const who = operatorOf(req);
    if (!who) return res.status(401).json({ error: "operator sign-in required", code: "OPERATOR_SIGN_IN" });
    const operator = store.findOperator(who.id);
    if (!operator) return res.status(401).json({ error: "operator sign-in required", code: "OPERATOR_SIGN_IN" });
    res.json({ operator: publicOperator(operator) });
  });

  return router;
}
