/**
 * Zoldenburg as the recovery guardian of a company's own Safe
 * (company-owned-safe-design.md §3.4, Q7), first half: the guardian on chain,
 * added through the org Safe queue. Arming it (the 1 € from the company's
 * IBAN, an org-scoped enrolment) is not built, so the guardian is never armed
 * here and /admin/recoveries refuses to sign for it (NOT_ARMED).
 *
 *  - readOrgRecovery: the module read by the Safe's address on every call.
 *    A read that fails throws; it is never "no guardian".
 *  - queueOrgGuardianSetup: one op that enables the module where needed and
 *    adds Zoldenburg at threshold 1, prepared for the chain's owners and
 *    queued for their signatures. Idempotent: an open setup op, or the
 *    guardian already on chain, queues nothing.
 *  - guardianSetupSignRefusal: the same one-guardian and no-pending rules,
 *    re-read from the module before each owner's signature (and so before
 *    the signature that relays it): the op may wait days in the queue.
 *  - Organisation.recovery is written once an executed setup op exists and
 *    the chain lists the guardian. It labels the UI; the chain is the truth.
 */
import type { MetaTransaction } from "abstractionkit";
import { store, type PendingSafeOp } from "../store.js";
import type { Account, Member, OrgSafePlan, Organisation } from "../domain/types.js";
import { OrgSafePlanRefusal, orgSafePlan } from "../domain/org-safe-plan.js";
import { zoldenburgGuardianAddress, zoldenburgRecoveryEnabled } from "../recovery/zoldenburg-guardian.js";
import { otherGuardianListed } from "../recovery/one-guardian.js";
import { redactedMessage } from "../http/log-cause.js";
import { orgSafeQueueEnabled } from "../config.js";
import {
  CANDIDE,
  assertRecoveryModuleDeployed,
  readRecoveryModule,
  recoveryGuardianSetupTransactions,
  type RecoveryModuleState,
} from "./candide.js";
import { OrgDebitRefusal, prepareOrgDebit, type OrgDebitPrepare } from "./org-debit.js";
import { SafeOpRefusal, assertQueueOpen, queueSafeOp } from "./org-safe-queue.js";
import type { OrgSafeReader } from "./org-signers.js";

type Address = `0x${string}`;

export const GUARDIAN_OP_KIND = "recovery-guardian";

export class OrgRecoveryRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OrgRecoveryRefusal";
  }
}

/** The chain, injected so a suite can play it. */
export interface OrgRecoveryChain {
  read(safeAddress: Address): Promise<RecoveryModuleState>;
  assertModuleDeployed(moduleAddress: Address): Promise<void>;
}

const moduleAddress = () => CANDIDE.recoveryModuleAddress as Address;

export const liveOrgRecoveryChain: OrgRecoveryChain = {
  read: (safeAddress) => readRecoveryModule(safeAddress, moduleAddress()),
  assertModuleDeployed: (m) => assertRecoveryModuleDeployed(m),
};

const low = (a: string) => a.toLowerCase();

/** The deployed org Safe and its euro account; null before deployment.
 *  Throws OrgSafePlanRefusal for an org with no Safe of its own. */
async function deployedSafe(org: Organisation): Promise<{ plan: OrgSafePlan; account: Account } | null> {
  let plan: OrgSafePlan;
  try {
    plan = orgSafePlan(org);
  } catch (err) {
    if (err instanceof OrgSafePlanRefusal && err.code === "ORG_SAFE_MISSING") return null;
    throw err;
  }
  const account = (await store.accountsOf(org.id)).find((a) => a.currency === "EUR" && !!a.address && low(a.address) === low(plan.address));
  return plan.status === "active" && account ? { plan, account } : null;
}

/** A setup op that is still open, or may have landed: a second one is never
 *  queued beside it. */
async function openSetupOp(orgId: string, safeAddress: string, now: number): Promise<PendingSafeOp | undefined> {
  return (await store.safeOpsOf(orgId)).find((op) =>
    op.kind === GUARDIAN_OP_KIND && low(op.safeAddress) === low(safeAddress) &&
    ((op.state === "PENDING" && Date.parse(op.expiresAt) > now) || op.state === "RELAYING" || op.state === "MANUAL_REVIEW"));
}

/** Write Organisation.recovery once an executed setup op exists and the chain
 *  lists the guardian it added. */
async function noteExecuted(org: Organisation, safeAddress: string, guardian: Address, onChain: boolean): Promise<Organisation["recovery"]> {
  return store.tx(async () => {
    if (!onChain) return undefined;
    const now = (await store.lockOrganisation(org.id)) ?? org;
    if (now.recovery && low(now.recovery.guardianAddress) === low(guardian)) return now.recovery;
    const done = (await store.safeOpsOf(org.id))
      .filter((op) => op.kind === GUARDIAN_OP_KIND && op.state === "EXECUTED" && low(op.safeAddress) === low(safeAddress))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!done) return undefined;
    const recovery = { guardianAddress: guardian, addedAt: done.updatedAt };
    await store.updateOrganisation(org.id, { recovery });
    return recovery;
  });
}

export type OrgRecoveryView =
  | { state: "not_set_up"; available: boolean; guardian: Address | null; armed: false }
  | {
      state: "set_up";
      available: boolean;
      guardian: Address | null;
      safeAddress: Address;
      moduleAddress: Address;
      moduleEnabled: boolean;
      guardians: Address[];
      /** Zoldenburg's current guardian is on the module. */
      guardianOnChain: boolean;
      /** Guardians Zold did not add: each could start a recovery alone. */
      otherGuardians: Address[];
      pendingRecovery: RecoveryModuleState["pending"];
      /** Never true yet: the org-scoped 1 € enrolment is not built. */
      armed: false;
      addedAt: string | null;
      setupOp: { id: string; state: PendingSafeOp["state"]; expiresAt: string } | null;
      /** The org Safe queue is switched on, so a setup could be queued. */
      queueOpen: boolean;
    };

/** The company's recovery as the chain has it. Throws OrgSafePlanRefusal for
 *  an org with no Safe of its own, and the read's own error when the module
 *  cannot be read. */
export async function readOrgRecovery(org: Organisation, chain: OrgRecoveryChain = liveOrgRecoveryChain, now = Date.now()): Promise<OrgRecoveryView> {
  const available = zoldenburgRecoveryEnabled();
  const guardian = zoldenburgGuardianAddress() ?? null;
  const safe = await deployedSafe(org);
  if (!safe) return { state: "not_set_up", available, guardian, armed: false };
  const state = await chain.read(safe.plan.address);
  const onChain = !!guardian && state.guardians.some((g) => low(g) === low(guardian));
  const recovery = guardian ? (await noteExecuted(org, safe.plan.address, guardian, onChain)) : undefined;
  const open = await openSetupOp(org.id, safe.plan.address, now);
  return {
    state: "set_up",
    available,
    guardian,
    safeAddress: safe.plan.address,
    moduleAddress: state.moduleAddress,
    moduleEnabled: state.moduleEnabled,
    guardians: state.guardians,
    guardianOnChain: onChain,
    otherGuardians: state.guardians.filter((g) => otherGuardianListed([g], guardian ?? undefined)),
    pendingRecovery: state.pending,
    armed: false,
    addedAt: recovery?.addedAt ?? null,
    setupOp: open ? { id: open.id, state: open.state, expiresAt: open.expiresAt } : null,
    queueOpen: orgSafeQueueEnabled(),
  };
}

/**
 * Queue the op that adds Zoldenburg to the company's Safe. Owners only: it
 * changes who can recover the Safe, the same rule as a signer change. Returns
 * the open op when one exists, and no op when the chain already lists the
 * guardian. Refused (OrgRecoveryRefusal) before anything is built when the
 * deployment offers no guardian, the Safe is not deployed, the module lists
 * another guardian or holds a recovery. A failed chain read throws as is.
 */
export async function queueOrgGuardianSetup(args: {
  org: Organisation;
  member: Member;
  chain?: OrgRecoveryChain;
  orgSafeReader?: OrgSafeReader;
  prepare?: OrgDebitPrepare;
  now?: number;
}): Promise<{ op: PendingSafeOp | null; created: boolean }> {
  const { org, member } = args;
  const chain = args.chain ?? liveOrgRecoveryChain;
  const now = args.now ?? Date.now();
  try {
    assertQueueOpen();
  } catch (err) {
    if (err instanceof SafeOpRefusal) throw new OrgRecoveryRefusal(err.status, err.code, err.message);
    throw err;
  }
  if (member.role !== "owner") {
    throw new OrgRecoveryRefusal(403, "OWNER_ONLY", "Only an owner can change who can recover the company’s Safe.");
  }
  const guardian = zoldenburgGuardianAddress();
  if (!guardian) throw new OrgRecoveryRefusal(503, "RECOVERY_UNAVAILABLE", "Zoldenburg recovery is not available on this deployment.");
  const safe = await deployedSafe(org);
  if (!safe) throw new OrgRecoveryRefusal(409, "ORG_SAFE_NOT_DEPLOYED", "The company’s Safe is not set up yet, so no guardian can be added to it.");
  const open = await openSetupOp(org.id, safe.plan.address, now);
  if (open) return { op: open, created: false };

  const module = moduleAddress();
  await chain.assertModuleDeployed(module);
  const state = await chain.read(safe.plan.address);
  if (state.guardians.some((g) => low(g) === low(guardian))) return { op: null, created: false };
  if (otherGuardianListed(state.guardians, guardian)) {
    throw new OrgRecoveryRefusal(409, "OTHER_GUARDIAN", "A recovery guardian Zold didn’t add is on the company’s Safe. Remove it in Safe{Wallet} first: each guardian could recover the Safe alone.");
  }
  if (state.pending) throw new OrgRecoveryRefusal(409, "RECOVERY_PENDING", "A recovery is pending on the company’s Safe. Cancel it first.");

  const txs: MetaTransaction[] = recoveryGuardianSetupTransactions(safe.plan.address, module, guardian, 1, state.moduleEnabled);
  let prepared;
  try {
    ({ prepared } = await prepareOrgDebit({
      org,
      account: safe.account,
      txs,
      ...(args.orgSafeReader ? { reader: args.orgSafeReader } : {}),
      ...(args.prepare ? { prepare: args.prepare } : {}),
    }));
  } catch (err) {
    if (err instanceof OrgDebitRefusal) throw new OrgRecoveryRefusal(err.status, err.code, err.message);
    throw err;
  }
  // The org and member as they are now, and no setup op queued meanwhile:
  // checked and written in one transaction, which holds the organisation.
  return store.tx(async () => {
    await store.lockOrganisation(org.id);
    const orgNow = await store.findOrganisation(org.id);
    const memberNow = await store.findMember(member.id);
    if (!orgNow || !memberNow || memberNow.status !== "active" || memberNow.role !== "owner") {
      throw new OrgRecoveryRefusal(409, "CANNOT_QUEUE", "This organisation or your membership changed; nothing was created.");
    }
    const raced = await openSetupOp(org.id, safe.plan.address, now);
    if (raced) return { op: raced, created: false };
    try {
      const op = await queueSafeOp({
        org: orgNow,
        member: memberNow,
        safeAddress: safe.plan.address,
        kind: GUARDIAN_OP_KIND,
        summary: `${state.moduleEnabled ? "" : "Enable the recovery module and "}${state.moduleEnabled ? "Add" : "add"} Zoldenburg UG (${guardian}) as the Safe’s recovery guardian`,
        prepared,
        guardianAddress: guardian,
      });
      return { op, created: true };
    } catch (err) {
      if (err instanceof SafeOpRefusal) throw new OrgRecoveryRefusal(err.status, err.code, err.message);
      throw err;
    }
  });
}

type SignRefusal = { status: number; code: string; error: string; invalidate?: string };

/**
 * Before an owner signs a recovery-guardian op (routes/business/safe-ops.ts):
 * the deployment still offers the guardian the op adds, and the module, read
 * now, lists neither it nor another guardian and holds no recovery. Any of
 * those ends the op (an owner can queue a fresh one once it is resolved); a
 * read that fails refuses this signature only.
 */
export async function guardianSetupSignRefusal(op: PendingSafeOp, chain: OrgRecoveryChain = liveOrgRecoveryChain): Promise<SignRefusal | undefined> {
  if (op.kind !== GUARDIAN_OP_KIND) return undefined;
  const guardian = zoldenburgGuardianAddress();
  // The guardian stored when the op was queued; an op queued before that field
  // existed falls back to finding the address in its UserOperation.
  const adds = (g: string) => (op.guardianAddress ? low(op.guardianAddress) === low(g) : low(op.userOperation).includes(low(g).slice(2)));
  if (!guardian || !adds(guardian)) {
    return { status: 409, code: "RECOVERY_UNAVAILABLE", error: "This deployment no longer offers the guardian this operation adds. Nothing was signed.", invalidate: "the deployment's guardian changed" };
  }
  let state: RecoveryModuleState;
  try {
    state = await chain.read(op.safeAddress);
  } catch (err) {
    console.error(`recovery-guardian op ${op.id}: module read failed before a signature: ${redactedMessage(err)}`);
    return { status: 502, code: "RECOVERY_UNREADABLE", error: "Couldn’t check the company’s Safe’s recovery on chain. Nothing was signed; try again." };
  }
  if (state.guardians.some((g) => low(g) === low(guardian))) {
    return { status: 409, code: "ALREADY_GUARDIAN", error: "Zoldenburg is already the Safe’s recovery guardian. Nothing was signed.", invalidate: "the guardian is already on the Safe" };
  }
  if (otherGuardianListed(state.guardians, guardian)) {
    return { status: 409, code: "OTHER_GUARDIAN", error: "A recovery guardian Zold didn’t add is now on the company’s Safe. Nothing was signed: remove it in Safe{Wallet}, then set up recovery again.", invalidate: "another guardian is on the Safe" };
  }
  if (state.pending) {
    return { status: 409, code: "RECOVERY_PENDING", error: "A recovery is pending on the company’s Safe. Nothing was signed: cancel it, then set up recovery again.", invalidate: "a recovery is pending on the Safe" };
  }
  return undefined;
}
