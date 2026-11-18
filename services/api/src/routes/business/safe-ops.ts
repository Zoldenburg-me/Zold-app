/**
 * /api/orgs/:orgId/safe-ops: the org Safe's operations waiting for owner
 * signatures (wallet/org-safe-queue.ts). Behind ORG_SAFE_QUEUE_ENABLED.
 *
 * Every member who may read drafts sees each op, who signed it and whose
 * signature is still missing. Only an owner whose passkey is an owner of the
 * Safe on chain signs; the op is relayed by the signature that meets the
 * Safe's own threshold. Nothing here creates an op: payments and owner
 * changes queue theirs (M2.3).
 */
import express from "express";
import { store, type PendingSafeOp } from "../../store.js";
import { SECURITY } from "../../config.js";
import { bufToB64url } from "../../webauthn.js";
import { checkOpAssertion } from "../../http/passkey-assertion.js";
import { canCancelSafeOp, signerRefusal, type SafeChainView } from "../../domain/safe-op-queue.js";
import { passkeyOwnerAddressOfJwk } from "../../wallet/safe-signers.js";
import { webauthnOwnerFromJwk, webauthnOwnerToStore } from "../../wallet/candide.js";
import {
  SafeOpRefusal,
  assertQueueOpen,
  liveSafeOpChain,
  refreshSafeOp,
  relayIfReady,
  type SafeOpChain,
} from "../../wallet/org-safe-queue.js";
import { requirePermission, type OrgContext } from "../org-context.js";
import { wrap } from "../util.js";
import type { OrgRoutes } from "./drafts.js";

const userOf = (m: { userId?: string } | undefined) => (m?.userId ? store.findUser(m.userId) : undefined);
const nameOf = (memberId: string) => userOf(store.findMember(memberId))?.name;

/** The op as the org sees it: an allowlist. Assertions and the UserOperation
 *  never leave the server. */
export function publicSafeOp(op: PendingSafeOp) {
  return {
    id: op.id,
    kind: op.kind,
    summary: op.summary,
    state: op.state,
    ...(op.reason ? { reason: op.reason } : {}),
    safeAddress: op.safeAddress,
    chainId: op.chainId,
    createdBy: { memberId: op.createdByMemberId, name: nameOf(op.createdByMemberId) },
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
    expiresAt: op.expiresAt,
    signatures: op.signatures.map((s) => ({ memberId: s.memberId, name: nameOf(s.memberId), ownerAddress: s.ownerAddress, signedAt: s.signedAt })),
    dropped: op.dropped.map((d) => ({ ...d, name: nameOf(d.memberId) })),
    ...(op.userOpHash ? { userOpHash: op.userOpHash } : {}),
    ...(op.txHash ? { txHash: op.txHash } : {}),
  };
}

/** The live part: the Safe's owners as the chain has them, matched to the
 *  org's owner members, and the threshold. */
function signerView(ctx: OrgContext, op: PendingSafeOp, view: SafeChainView) {
  const byAddress = new Map<string, { memberId: string; name?: string }>();
  for (const m of store.membersOf(ctx.org.id)) {
    if (m.status !== "active" || m.role !== "owner") continue;
    const user = userOf(m);
    const jwk = user?.passkey?.publicKey?.jwk;
    const address = jwk ? passkeyOwnerAddressOfJwk(jwk) : null;
    if (address) byAddress.set(address.toLowerCase(), { memberId: m.id, name: user?.name });
  }
  const signed = new Set(op.signatures.map((s) => s.ownerAddress.toLowerCase()));
  return {
    threshold: view.threshold,
    owners: view.owners.map((address) => ({
      address,
      ...(byAddress.get(address.toLowerCase()) ?? {}),
      signed: signed.has(address.toLowerCase()),
    })),
  };
}

const challengeOf = (op: PendingSafeOp) => bufToB64url(Buffer.from(op.digest.slice(2), "hex"));

export function createSafeOpRoutes(deps: OrgRoutes, chain: SafeOpChain = liveSafeOpChain): express.Router {
  const r = express.Router();

  /** Flag, org, role and the op, or the refusal. */
  const load = (req: express.Request, res: express.Response): { ctx: OrgContext; op?: PendingSafeOp } | undefined => {
    try {
      assertQueueOpen();
    } catch (err) {
      const e = err as SafeOpRefusal;
      res.status(e.status).json({ error: e.message, code: e.code });
      return undefined;
    }
    const ctx = deps.ctxOf(req, res);
    if (!ctx) return undefined;
    if (!requirePermission(ctx, res, "drafts.read")) return undefined;
    if (!req.params.opId) return { ctx };
    const op = store.findSafeOp(String(req.params.opId));
    if (!op || op.orgId !== ctx.org.id) {
      res.status(404).json({ error: "no such operation" });
      return undefined;
    }
    return { ctx, op };
  };

  const answerRefusal = (res: express.Response, err: unknown) => {
    if (err instanceof SafeOpRefusal) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return true;
    }
    return false;
  };

  r.get("/:orgId/safe-ops", (req, res) => {
    const loaded = load(req, res);
    if (!loaded) return;
    const ops = store.safeOpsOf(loaded.ctx.org.id).map(publicSafeOp);
    res.json({ ops: ops.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  });

  r.get(
    "/:orgId/safe-ops/:opId",
    wrap(async (req, res) => {
      const loaded = load(req, res);
      if (!loaded) return;
      const { ctx, op } = loaded;
      if (op!.state !== "PENDING") return res.json({ op: publicSafeOp(op!) });
      const passkey = store.findUser(ctx.userId)?.passkey;
      try {
        const fresh = await refreshSafeOp(op!, chain);
        res.json({
          op: publicSafeOp(fresh.op),
          ...signerView(ctx, fresh.op, fresh.view),
          ...(fresh.op.state === "PENDING" ? { challenge: challengeOf(fresh.op), waitingForEarlierOp: fresh.check.waitingForEarlierOp } : {}),
          ...(passkey ? { signWith: { credentialId: passkey.credentialId, rpId: passkey.rpId ?? SECURITY.rpId } } : {}),
        });
      } catch (err) {
        if (!answerRefusal(res, err)) throw err;
      }
    }),
  );

  r.post(
    "/:orgId/safe-ops/:opId/signatures",
    wrap(async (req, res) => {
      const loaded = load(req, res);
      if (!loaded) return;
      const { ctx } = loaded;
      let op = loaded.op!;
      const notPending = () => res.status(409).json({ error: `This operation is ${op.state.toLowerCase()}; it takes no more signatures.`, code: "NOT_PENDING", op: publicSafeOp(op) });
      if (op.state !== "PENDING") return notPending();
      const user = store.findUser(ctx.userId);
      const jwk = user?.passkey?.publicKey?.jwk;
      const owner = jwk ? webauthnOwnerFromJwk(jwk) : null;
      const ownerAddress = jwk ? passkeyOwnerAddressOfJwk(jwk) : null;
      let view: SafeChainView;
      try {
        const fresh = await refreshSafeOp(op, chain);
        op = fresh.op;
        view = fresh.view;
      } catch (err) {
        if (answerRefusal(res, err)) return;
        throw err;
      }
      if (op.state !== "PENDING") return notPending();
      const refusal = signerRefusal(ctx.member, ownerAddress, view.owners);
      if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
      if (op.signatures.some((s) => s.memberId === ctx.member.id || s.ownerAddress.toLowerCase() === ownerAddress!.toLowerCase())) {
        return res.status(409).json({ error: "You have signed this operation already.", code: "ALREADY_SIGNED" });
      }
      if (!(await checkOpAssertion(user!, req.body, challengeOf(op), res))) return;
      const added = store.addSafeOpSignature(op.id, {
        memberId: ctx.member.id,
        userId: ctx.userId,
        ownerAddress: ownerAddress!,
        passkeyPublicKey: webauthnOwnerToStore(owner!),
        authenticatorData: String(req.body.authenticatorData),
        clientDataJSON: String(req.body.clientDataJSON),
        signature: String(req.body.signature),
        signedAt: new Date().toISOString(),
      });
      if (!added) {
        op = store.findSafeOp(op.id)!;
        return op.state === "PENDING"
          ? res.status(409).json({ error: "You have signed this operation already.", code: "ALREADY_SIGNED" })
          : notPending();
      }
      const after = await relayIfReady(added, chain);
      const fresh = after.state === "PENDING" ? signerView(ctx, after, view) : {};
      res.status(after.state === "FAILED" || after.state === "MANUAL_REVIEW" ? 502 : 201).json({ op: publicSafeOp(after), ...fresh });
    }),
  );

  r.post("/:orgId/safe-ops/:opId/cancel", (req, res) => {
    const loaded = load(req, res);
    if (!loaded) return;
    const { ctx, op } = loaded;
    if (!canCancelSafeOp(ctx.member, op!)) {
      return res.status(403).json({ error: "Only the person who queued this operation, or an owner, can withdraw it.", code: "CANNOT_CANCEL" });
    }
    const ended = store.endPendingSafeOp(op!.id, { state: "CANCELLED", reason: `withdrawn by ${nameOf(ctx.member.id) ?? "a member"}` });
    if (!ended) return res.status(409).json({ error: `This operation is ${op!.state.toLowerCase()}; it can no longer be withdrawn.`, code: "NOT_PENDING" });
    res.json({ op: publicSafeOp(ended) });
  });

  return r;
}
