/**
 * The fresh passkey approval every admin change needs. The challenge is
 * bound to the operator, the method, the path and a hash of the body, so an
 * approval for one action cannot be replayed on another route, another
 * target or other values.
 */
import { createHash } from "node:crypto";
import type express from "express";
import { OPERATOR, SECURITY } from "../config.js";
import { store } from "../store.js";
import { verifyAssertion } from "../webauthn.js";
import type { Operator } from "../store/types.js";

export const STEP_UP_HEADER = "x-operator-step-up";

/** A trailing slash reaches the same handler, so it is not part of the
 *  binding. Case is: an id in a path may be case-sensitive, and an approval
 *  for one spelling is not an approval for another. */
export const bindingPath = (p: string) => (p.replace(/\/+$/, "") || "/");

/** The parsed body as the server holds it; a client that sends the same JSON
 *  text to the challenge and to the request gets the same hash. */
export const bodyHash = (body: unknown) =>
  createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");

export const operatorStepUpBinding = (operatorId: string, method: string, path: string, body: unknown) =>
  `op:${operatorId}:${method.toUpperCase()} ${bindingPath(path)}:${bodyHash(body)}`;

export class StepUpRefusal extends Error {
  constructor(message: string, public code: "STEP_UP_REQUIRED" | "STEP_UP_INVALID") {
    super(message);
    this.name = "StepUpRefusal";
  }
}

interface StepUpAssertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

function parseHeader(raw: string | undefined): StepUpAssertion {
  if (!raw) throw new StepUpRefusal("this change needs a fresh passkey approval", "STEP_UP_REQUIRED");
  let a: any;
  try {
    a = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new StepUpRefusal("the passkey approval is malformed", "STEP_UP_INVALID");
  }
  for (const k of ["credentialId", "authenticatorData", "clientDataJSON", "signature"]) {
    if (typeof a?.[k] !== "string" || !a[k]) throw new StepUpRefusal("the passkey approval is incomplete", "STEP_UP_INVALID");
  }
  return a as StepUpAssertion;
}

/** Verifies the approval in the request's header against this request. */
export async function verifyOperatorStepUp(req: express.Request, operator: Operator): Promise<void> {
  const a = parseHeader(req.header(STEP_UP_HEADER));
  const credential = operator.credentials.find((c) => c.credentialId === a.credentialId);
  if (!credential) throw new StepUpRefusal("that passkey is not one of this operator's", "STEP_UP_INVALID");
  const binding = operatorStepUpBinding(operator.id, req.method, req.baseUrl + req.path, req.body);
  let signCount: number;
  try {
    ({ signCount } = await verifyAssertion(
      a.authenticatorData,
      a.clientDataJSON,
      a.signature,
      credential.key,
      credential.signCount,
      SECURITY.rpId,
      [OPERATOR.adminOrigin],
      "operator_step_up",
      binding,
    ));
  } catch {
    throw new StepUpRefusal("the passkey approval does not match this change: approve it again", "STEP_UP_INVALID");
  }
  store.recordOperatorCredentialUse(operator.id, credential.credentialId, signCount);
}
