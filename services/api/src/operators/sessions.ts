/**
 * Operator sessions: a `zop_` bearer, stored as a hash, 8 hours at most and
 * 30 minutes idle. A user session is never one, and an operator session is
 * never a user's: each lives in its own store and is looked up only there.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { OPERATOR } from "../config.js";
import { tokenHash } from "../http/sessions.js";
import { store } from "../store.js";
import type { Operator, OperatorSession } from "../store/types.js";

export const OPERATOR_TOKEN_PREFIX = "zop_";

export async function issueOperatorSession(operatorId: string): Promise<string> {
  const token = `${OPERATOR_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  await store.addOperatorSession({
    id: randomUUID(),
    operatorId,
    tokenHash: tokenHash(token),
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(nowMs + OPERATOR.sessionTtlMs).toISOString(),
  });
  return token;
}

/** The live session and its operator for a bearer, or why there is none. */
export async function operatorSessionFor(
  token: string | undefined,
): Promise<{ session: OperatorSession; operator: Operator } | { refused: string }> {
  if (!token?.startsWith(OPERATOR_TOKEN_PREFIX)) return { refused: "operator sign-in required" };
  const session = await store.findOperatorSessionByTokenHash(tokenHash(token));
  if (!session) return { refused: "invalid operator session" };
  const now = Date.now();
  if (session.revokedAt || now >= Date.parse(session.expiresAt) || now - Date.parse(session.lastUsedAt) > OPERATOR.sessionIdleMs) {
    return { refused: "operator session expired: sign in again" };
  }
  const operator = await store.findOperator(session.operatorId);
  if (!operator || operator.disabledAt) return { refused: "this operator is disabled" };
  return { session, operator };
}
