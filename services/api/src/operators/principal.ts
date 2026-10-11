/**
 * Who an admin request is from, set by the operator gate (operators/gate.ts)
 * and read by `requireOperator`. Held per request object, so nothing a
 * client sends can set it.
 */
import type express from "express";

export interface OperatorPrincipal {
  /** The operator's id, or "legacy-token" for the read-only shared token. */
  id: string;
  name: string;
  legacy: boolean;
  /** The passkey session's id; absent for the legacy token. */
  sessionId?: string;
}

const principals = new WeakMap<express.Request, OperatorPrincipal>();
const accessEmails = new WeakMap<express.Request, string>();

export const operatorOf = (req: express.Request) => principals.get(req);
export const setOperator = (req: express.Request, p: OperatorPrincipal) => void principals.set(req, p);

/** The email Cloudflare Access signed for this request; absent where Access
 *  is not configured (outside production). */
export const accessEmailOf = (req: express.Request) => accessEmails.get(req);
export const setAccessEmail = (req: express.Request, email: string) => void accessEmails.set(req, email);
