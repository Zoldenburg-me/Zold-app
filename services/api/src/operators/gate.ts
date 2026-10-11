/**
 * The one gate in front of every /api/admin route, mounted by server.ts ahead
 * of every admin router. In order:
 *
 * 1. On a hosted deployment the dashboard is ready or refused: an explicit
 *    admin origin of its own and Cloudflare Access configured.
 * 2. Cloudflare Access, where configured (always when hosted): the signed
 *    identity of the person in front of the browser.
 * 3. The caller: an operator passkey session, whose email must equal the
 *    Access identity. There is no other way in.
 * 4. Every request that is not a read needs a fresh passkey approval bound to
 *    that exact request (operators/step-up.ts). The method decides, here, so a
 *    new admin route cannot forget it.
 * 5. An audit row naming the operator: every change, and each read of a path
 *    once per operator in ten minutes (the dashboard refreshes itself).
 *
 * The ceremonies that create a session (login, enrolment) pass step 3 with no
 * session and check the Access identity themselves.
 */
import type express from "express";
import { OPERATOR, SECURITY } from "../config.js";
import { auditEntry } from "../audit.js";
import { recordFailure, tooManyFailures } from "../http/policy.js";
import { bearerToken } from "../http/sessions.js";
import { store } from "../store.js";
import { AccessRefusal, accessConfigured, accessRequired, verifyAccessJwt } from "./access.js";
import { accessEmailOf, setAccessEmail, setOperator, type OperatorPrincipal } from "./principal.js";
import { operatorSessionFor } from "./sessions.js";
import { StepUpRefusal, verifyOperatorStepUp } from "./step-up.js";

/** Ceremonies that start a session: Access applies, a session cannot. */
const SESSIONLESS = new Set(["/auth/login/challenge", "/auth/login", "/auth/enrol/challenge", "/auth/enrol"]);
/** Need a session but no fresh approval: asking for a challenge to approve
 *  with, and ending the session. */
const NO_STEP_UP = new Set(["/auth/step-up/challenge", "/auth/passkeys/challenge", "/auth/logout"]);
const READS = new Set(["GET", "HEAD"]);

/** Per session: a stolen session that guesses burns itself, not the operator. */
const STEP_UP_FAILURES_MAX = 10;
const STEP_UP_FAILURE_WINDOW_MS = 15 * 60_000;
const READ_AUDIT_EVERY_MS = 10 * 60_000;

/** Why a hosted deployment refuses the dashboard, or undefined when it may run. */
export function adminNotReady(): string | undefined {
  if (!OPERATOR.hardened) return undefined;
  if (!OPERATOR.adminOriginExplicit) return "ADMIN_ORIGIN is not set: the dashboard runs only on an origin of its own";
  if (!OPERATOR.adminOrigin.startsWith("https://")) return "ADMIN_ORIGIN must use https";
  if (SECURITY.origins.includes(OPERATOR.adminOrigin)) return "ADMIN_ORIGIN must not be one of the app's WEBAUTHN_ORIGINS";
  if (!accessConfigured()) return "Cloudflare Access is not configured: set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD";
  return undefined;
}

const lastReadAudit = new Map<string, number>();

function readAuditDue(key: string, now: number): boolean {
  for (const [k, at] of lastReadAudit) if (now - at >= READ_AUDIT_EVERY_MS) lastReadAudit.delete(k);
  return !lastReadAudit.has(key);
}

/** The row is written once the request ends, however it ends: a change the
 *  handler made is audited even if the client went away before the answer. */
function auditOnFinish(req: express.Request, res: express.Response, who: OperatorPrincipal) {
  const asSent = req.path.replace(/\/+$/, "") || "/";
  // A live read asks a partner: it is audited every time.
  const read = READS.has(req.method) && req.query.live === undefined;
  const key = `${who.id} ${asSent.toLowerCase()}`;
  if (read && !readAuditDue(key, Date.now())) return;
  const userId = /^\/users\/([^/]+)/i.exec(asSent)?.[1];
  let written = false;
  const write = () => {
    if (written) return;
    written = true;
    if (read) lastReadAudit.set(key, Date.now());
    store.audit(auditEntry("operator.request", {
      operator: `operator:${who.id}`,
      operatorName: who.name,
      method: req.method,
      path: `/api/admin${asSent}`,
      ...(req.query.live === "1" ? { live: true } : {}),
      status: res.statusCode,
      ...(res.writableFinished ? {} : { clientGone: true }),
    }, userId));
  };
  res.on("finish", write);
  res.on("close", write);
}

async function admit(req: express.Request, res: express.Response): Promise<boolean> {
  const notReady = adminNotReady();
  if (notReady) {
    res.status(503).json({ error: notReady, code: "ADMIN_NOT_READY" });
    return false;
  }
  if (accessRequired()) {
    try {
      const { email } = await verifyAccessJwt(req.header("cf-access-jwt-assertion"));
      setAccessEmail(req, email);
    } catch (err) {
      if (!(err instanceof AccessRefusal)) throw err;
      res.status(err.status).json({ error: err.message, code: "ACCESS_REQUIRED" });
      return false;
    }
  }
  // Lowercased for the exempt-route lookups only, as Express matches routes.
  const path = req.path.toLowerCase().replace(/\/+$/, "") || "/";
  if (SESSIONLESS.has(path)) return true;
  // An approval binds method, path and body; a query on a change would ride
  // along unbound, so a change carries none.
  if (!READS.has(req.method) && req.originalUrl.includes("?")) {
    res.status(400).json({ error: "a change takes no query string", code: "QUERY_ON_CHANGE" });
    return false;
  }

  const found = operatorSessionFor(bearerToken(req));
  if ("refused" in found) {
    res.status(401).json({ error: found.refused, code: "OPERATOR_SIGN_IN" });
    return false;
  }
  const { session, operator } = found;
  const accessEmail = accessEmailOf(req);
  if (accessEmail !== undefined && accessEmail !== operator.email) {
    res.status(403).json({ error: "signed in to Cloudflare Access as someone other than this operator", code: "ACCESS_MISMATCH" });
    return false;
  }
  if (!READS.has(req.method) && !NO_STEP_UP.has(path)) {
    const key = `opstep:${session.id}`;
    try {
      await verifyOperatorStepUp(req, operator);
    } catch (err) {
      if (!(err instanceof StepUpRefusal)) throw err;
      recordFailure(key, STEP_UP_FAILURE_WINDOW_MS);
      const locked = tooManyFailures(key, STEP_UP_FAILURES_MAX);
      if (locked) store.revokeOperatorSession(session.id);
      store.audit(auditEntry("operator.step_up_refused", {
        operator: `operator:${operator.id}`, operatorName: operator.name, method: req.method,
        path: `/api/admin${req.path}`, code: err.code, ...(locked ? { sessionRevoked: true } : {}),
      }));
      res.status(locked ? 401 : 403).json(locked
        ? { error: "too many failed approvals: this session is ended, sign in again", code: "OPERATOR_SIGN_IN" }
        : { error: err.message, code: err.code });
      return false;
    }
  }
  store.touchOperatorSession(session.id);
  const who: OperatorPrincipal = { id: operator.id, name: operator.name, sessionId: session.id };
  setOperator(req, who);
  auditOnFinish(req, res, who);
  return true;
}

export function createOperatorGate(): express.RequestHandler {
  return (req, res, next) => {
    admit(req, res).then((ok) => ok && next(), next);
  };
}
