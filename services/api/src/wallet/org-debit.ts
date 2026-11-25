/**
 * A company's debit from its org Safe: the two halves every company payment
 * shares. Crypto sends use them (routes/crypto-sends.ts); bank drafts are to
 * reuse them.
 *
 *  - prepareOrgDebit: the org Safe as the source (deployed, plan active), the
 *    signers the server names for the gas estimate, and the op prepared once
 *    for them. The signers are the chain's owners joined to the owner
 *    members' login passkeys: never the caller's key (a payer queues and
 *    holds none), never plan.owners (the deployment's list, stale after any
 *    owner change).
 *  - orgOpOutcome: what a queued op means for the business record waiting on
 *    it, derived on read, so the record and the op cannot disagree.
 */
import type { MetaTransaction, WebauthnPublicKey } from "abstractionkit";
import { store, type CryptoSend, type PendingSafeOp } from "../store.js";
import type { Account, Member, OrgSafePlan, Organisation } from "../domain/types.js";
import { OrgSafePlanRefusal, orgSafePlan } from "../domain/org-safe-plan.js";
import { assertReadableSafeState } from "../domain/safe-op-queue.js";
import { prepareSafeOperation, webauthnOwnerFromJwk, type PreparedSafeOperation } from "./candide.js";
import { liveOrgSafeReader, ownerAddressOfMember, type OrgSafeReader } from "./org-signers.js";
import { filterSeq, mapSeq } from "../seq.js";

export class OrgDebitRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OrgDebitRefusal";
  }
}

const low = (a: string) => a.toLowerCase();

/**
 * The org Safe a company account pays from, or a refusal by name. The
 * account's IBAN is not asked for: a wallet payout needs only the Safe. A
 * suspended or errored account pays nothing.
 */
export function orgDebitSource(org: Organisation, account: Account): OrgSafePlan {
  let plan: OrgSafePlan;
  try {
    plan = orgSafePlan(org);
  } catch (err) {
    if (err instanceof OrgSafePlanRefusal) throw new OrgDebitRefusal(err.status, err.code, err.message);
    throw err;
  }
  if (plan.status !== "active" || !account.address) {
    throw new OrgDebitRefusal(409, "ORG_SAFE_NOT_DEPLOYED", "The company’s Safe is not set up yet, so nothing can be sent from it.");
  }
  if (account.orgId !== org.id || account.currency !== "EUR" || low(account.address) !== low(plan.address)) {
    throw new OrgDebitRefusal(409, "NOT_THE_ORG_SAFE", "This account is not the company’s Safe, so nothing can be sent from it here.");
  }
  if (account.status === "suspended" || account.status === "error") {
    throw new OrgDebitRefusal(409, "ACCOUNT_UNAVAILABLE", `This account is ${account.status}, so nothing can be sent from it.`);
  }
  return plan;
}

/**
 * The passkeys an op on this org Safe is prepared for: as many current
 * owners as the chain's threshold. An owner is a chain owner whose address is
 * the login passkey of exactly one active owner member; two members on one
 * address is ambiguous and refused. The deploying owner (Member.signerAddress
 * still their passkey's address) comes first, so at 1-of-1 it is them.
 */
export async function orgDebitSigners(org: Organisation, plan: OrgSafePlan, reader: OrgSafeReader = liveOrgSafeReader): Promise<WebauthnPublicKey[]> {
  const chain = await reader.read(plan.address);
  assertReadableSafeState(plan.address, chain);
  const byOwner = new Map<string, Member[]>();
  for (const m of (await store.membersOf(org.id))) {
    if (m.status !== "active" || m.role !== "owner") continue;
    const a = await ownerAddressOfMember(m);
    if (!a || !chain.owners.some((o) => low(o) === low(a))) continue;
    byOwner.set(low(a), [...(byOwner.get(low(a)) ?? []), m]);
  }
  if ([...byOwner.values()].some((ms) => ms.length > 1)) {
    throw new OrgDebitRefusal(409, "AMBIGUOUS_SIGNER", "Two members of this company sign with the same passkey, so Zold cannot tell who signs. Nothing was created.");
  }
  const deployed = async (m: Member) => !!m.signerAddress && low(m.signerAddress) === low((await ownerAddressOfMember(m))!);
  const candidates = chain.owners.map((o) => byOwner.get(low(o))?.[0]).filter((m): m is Member => !!m);
  const isDeployed = new Map(await mapSeq(candidates, async (m) => [m.id, await deployed(m)] as const));
  const members = candidates.sort((a, b) => Number(isDeployed.get(b.id)) - Number(isDeployed.get(a.id)));
  if (members.length < chain.threshold) {
    throw new OrgDebitRefusal(409, "NOT_ENOUGH_SIGNERS", `The company’s Safe needs ${chain.threshold} owner signature${chain.threshold === 1 ? "" : "s"}, and ${members.length} of its owners sign with a passkey here. Nothing was created.`);
  }
  // ownerAddressOfMember found a P-256 login passkey for each of these.
  return await mapSeq(members.slice(0, chain.threshold), async (m) => webauthnOwnerFromJwk((await store.findUser(m.userId!))!.passkey!.publicKey!.jwk!)!);
}

export type OrgDebitPrepare = (plan: OrgSafePlan, txs: MetaTransaction[], signers: WebauthnPublicKey[]) => Promise<PreparedSafeOperation & { nonce: bigint }>;

const livePrepare: OrgDebitPrepare = async (plan, txs, signers) => {
  const prepared = await prepareSafeOperation(plan, txs, signers);
  const nonce = (prepared as { nonce?: unknown }).nonce;
  if (typeof nonce !== "bigint") throw new Error("an org Safe operation was prepared without its nonce");
  return { ...prepared, nonce };
};

/** Prepare `txs` on the org Safe behind `account`, for the signers the server
 *  names. Throws OrgDebitRefusal before anything is built. */
export async function prepareOrgDebit(args: {
  org: Organisation;
  account: Account;
  txs: MetaTransaction[];
  reader?: OrgSafeReader;
  prepare?: OrgDebitPrepare;
}): Promise<{ plan: OrgSafePlan; prepared: PreparedSafeOperation & { nonce: bigint } }> {
  const plan = orgDebitSource(args.org, args.account);
  const signers = await orgDebitSigners(args.org, plan, args.reader);
  return { plan, prepared: await (args.prepare ?? livePrepare)(plan, args.txs, signers) };
}

export type OrgOpOutcome =
  | { state: "QUEUED" }
  | { state: "SUBMITTED"; userOpHash?: string }
  | { state: "DONE"; userOpHash?: string; txHash?: string }
  | { state: "FAILED"; reason: string; txHash?: string };

/**
 * What an op means for the record waiting on it. QUEUED until the owners
 * have signed; SUBMITTED while relaying, and in MANUAL_REVIEW, which may have
 * landed; DONE once executed. Every other end, and a pending op past its
 * expiry (it can never relay: refreshSafeOp ends it), is FAILED.
 */
export function orgOpOutcome(op: PendingSafeOp | undefined, now = Date.now()): OrgOpOutcome {
  if (!op) return { state: "FAILED", reason: "the operation is missing" };
  switch (op.state) {
    case "PENDING":
      return Date.parse(op.expiresAt) <= now ? { state: "FAILED", reason: "not enough owners signed in time" } : { state: "QUEUED" };
    case "RELAYING":
    case "MANUAL_REVIEW":
      return { state: "SUBMITTED", ...(op.userOpHash ? { userOpHash: op.userOpHash } : {}) };
    case "EXECUTED":
      return { state: "DONE", ...(op.userOpHash ? { userOpHash: op.userOpHash } : {}), ...(op.txHash ? { txHash: op.txHash } : {}) };
    case "EXPIRED":
      return { state: "FAILED", reason: op.reason ?? "not enough owners signed in time" };
    case "CANCELLED":
      return { state: "FAILED", reason: op.reason ?? "withdrawn" };
    default:
      return { state: "FAILED", reason: op.reason ?? `the operation ended ${op.state.toLowerCase()}`, ...(op.txHash ? { txHash: op.txHash } : {}) };
  }
}

/**
 * A send as it stands: a personal send as stored, a company send from its
 * op. The one exception to "from the op" is MANUAL_REVIEW, which the op
 * never leaves: a receipt check (settleUnconfirmedCryptoSends) writes what the
 * chain said onto the send, and that answer is used.
 */
export async function liveCryptoSend(send: CryptoSend, now = Date.now()): Promise<CryptoSend> {
  if (!send.safeOpId) return send;
  const op = await store.findSafeOp(send.safeOpId);
  const o = orgOpOutcome(op, now);
  const settled = op?.state === "MANUAL_REVIEW" && (send.state === "SENT" || send.state === "FAILED");
  if (settled) return send;
  switch (o.state) {
    case "QUEUED":
      return { ...send, state: "CREATED" };
    case "SUBMITTED":
      return { ...send, state: "SUBMITTED", ...(o.userOpHash ? { userOpHash: o.userOpHash } : {}) };
    case "DONE":
      return { ...send, state: "SENT", ...(o.userOpHash ? { userOpHash: o.userOpHash } : {}), ...(o.txHash ? { txHash: o.txHash } : {}), error: undefined };
    case "FAILED":
      return { ...send, state: "FAILED", error: o.reason, ...(o.txHash ? { txHash: o.txHash } : {}) };
  }
}

/** The daily cap's key for an org Safe: the cap is per Safe, not per member. */
export const orgSafeCapKey = (safeAddress: string) => `org-safe:${low(safeAddress)}`;

/** Euros sent or held today from this org Safe. A send whose op ended any way
 *  but executed (or may have) stops counting, so its hold is given back. */
export async function orgSafeSpentEurToday(safeAddress: string, now = new Date()): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  return (await store.heldEurToday(orgSafeCapKey(safeAddress), day)) + (await filterSeq((await filterSeq((await store.list("cryptoSends")), async (c) => c.safeOpId && c.createdAt.slice(0, 10) === day && low((await store.findSafeOp(c.safeOpId))?.safeAddress ?? "") === low(safeAddress))), async (c) => (await liveCryptoSend(c, now.getTime())).state !== "FAILED"))
    .reduce((sum, c) => sum + c.capEur, 0);
}
