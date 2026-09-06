/**
 * Account documents — routes.
 *
 * Authenticated half (`/users/:id/documents/*`): the holder creates a
 * receipt, a statement, a balance confirmation or a proof of ownership. Each
 * becomes a StoredDocument under a verification code and is signed by the
 * server's document key. Proof of ownership can additionally be signed by
 * the holder's own Safe in one passkey ceremony, which is the part nobody can
 * produce from a screenshot.
 *
 * Public half (`/v/:code`): anyone holding a code reads the frozen snapshot
 * and a LIVE verdict — the server signature is re-verified, a balance letter
 * is re-read from the chain at its block, and a Safe signature is checked
 * with the account contract. A document that verifies is one whose facts
 * this server stands behind now, not one it merely printed once.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { CHAIN_ID, HARNESS, SECURITY } from "../config.js";
import { store, type Transfer, type User } from "../store.js";
import { abis, addrs, eur, publicClient } from "../chain.js";
import { moneriumClientFor, moneriumLiveFor } from "../adapters/monerium-connection.js";
import { safeMessageHash, signMessageAsPasskeySafe, type PasskeySafeDeploymentPlan } from "../wallet/candide.js";
import { b64urlToBuf, bufToB64url, verifyAssertionForChallenge } from "../webauthn.js";
import {
  type BalanceSnapshot,
  type DocumentSnapshot,
  type OwnershipSnapshot,
  PARTIES,
  type ReceiptSnapshot,
  type StatementSnapshot,
  type StoredDocument,
  holderBlock,
  isDocumentCode,
  linesFromChainCredits,
  linesFromMoneriumOrders,
  linesFromTransfers,
  mergeLines,
  newDocumentCode,
  normaliseCode,
  ownershipMessage,
  ownershipStatement,
  publicDocument,
  reconcile,
  signSnapshot,
  statementTotals,
  verifyZoldAttestation,
} from "../documents.js";

export interface DocumentsDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}

// ---------------------------------------------------------------------------
// chain reads

async function blockAt(numberOrTag: bigint | "latest") {
  const blk =
    numberOrTag === "latest"
      ? await publicClient.getBlock({ blockTag: "latest" })
      : await publicClient.getBlock({ blockNumber: numberOrTag });
  return { number: Number(blk.number), hash: blk.hash as string | undefined, at: new Date(Number(blk.timestamp) * 1000).toISOString() };
}

/** The last block mined at or before `when` — a binary search over block
 *  timestamps, about 30 reads on Base. Null when the chain is younger. */
async function blockAtOrBefore(when: Date): Promise<{ number: number; hash?: string; at: string } | null> {
  const target = Math.floor(when.getTime() / 1000);
  const head = await publicClient.getBlock({ blockTag: "latest" });
  if (Number(head.timestamp) <= target) return blockAt(head.number);
  let lo = 0n;
  let hi = head.number;
  const first = await publicClient.getBlock({ blockNumber: 0n }).catch(() => null);
  if (first && Number(first.timestamp) > target) return null;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const b = await publicClient.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) <= target) lo = mid;
    else hi = mid;
  }
  return blockAt(lo);
}

async function balanceAtBlock(address: `0x${string}`, blockNumber: number): Promise<number> {
  const wei = (await publicClient.readContract({
    address: addrs().eure,
    abi: abis.MockToken,
    functionName: "balanceOf",
    args: [address],
    blockNumber: BigInt(blockNumber),
  })) as bigint;
  return eur.fromWei(wei);
}

// ---------------------------------------------------------------------------
// builders that need the store, the chain and Monerium

async function moneriumOrdersFor(user: User): Promise<{ orders: any[]; status: "ok" | string }> {
  if (!moneriumLiveFor(user)) return { orders: [], status: "no Monerium connection on this account" };
  const profileId = user.monerium?.profileId ?? user.funding?.moneriumProfileId;
  try {
    const res: any = await moneriumClientFor(user).orders(profileId);
    const orders = Array.isArray(res) ? res : (res?.orders ?? []);
    return { orders, status: "ok" };
  } catch (err: any) {
    return { orders: [], status: `Monerium unavailable: ${String(err?.message ?? err).slice(0, 120)}` };
  }
}

export async function buildStatement(user: User, from: Date, to: Date): Promise<StatementSnapshot> {
  const holder = holderBlock(user);
  const inPeriod = (at: string) => {
    const t = Date.parse(at);
    return t >= from.getTime() && t <= to.getTime();
  };
  const transfers = store.transfers.filter((t: Transfer) => t.userId === user.id);
  const credits = store.cryptoDeposits.filter((d) => d.userId === user.id);
  const mon = await moneriumOrdersFor(user);
  const lines = mergeLines(
    linesFromMoneriumOrders(mon.orders, user.address),
    linesFromTransfers(transfers),
    linesFromChainCredits(credits),
  ).filter((l) => inPeriod(l.at));

  let opening: StatementSnapshot["opening"] = null;
  let closing: StatementSnapshot["closing"] = null;
  let chainStatus: string = "ok";
  try {
    const openBlock = await blockAtOrBefore(new Date(from.getTime() - 1));
    const closeBlock = await blockAtOrBefore(to);
    if (closeBlock) closing = { ...closeBlock, amountEur: await balanceAtBlock(holder.safeAddress, closeBlock.number) };
    if (openBlock) opening = { ...openBlock, amountEur: await balanceAtBlock(holder.safeAddress, openBlock.number) };
    else if (closeBlock) opening = { number: 0, at: from.toISOString(), amountEur: 0 };
  } catch (err: any) {
    chainStatus = `chain unavailable: ${String(err?.message ?? err).slice(0, 120)}`;
  }
  const totals = statementTotals(lines);
  return {
    kind: "statement",
    holder,
    period: { from: from.toISOString(), to: to.toISOString() },
    opening,
    closing,
    lines,
    totals,
    reconciliation: reconcile(opening?.amountEur ?? null, closing?.amountEur ?? null, totals),
    sources: { chain: chainStatus, monerium: mon.status, transfers: "ok" },
  };
}

/**
 * A receipt is a PROOF OF PAYMENT — what someone hands to a tax office or a
 * landlord — so it exists only once the payout has settled (PAID: Monerium
 * processed the redeem). A payment that is submitted but not yet processed
 * is a statement line, not a proof.
 */
export function buildReceipt(user: User, transfer: Transfer): ReceiptSnapshot {
  if (transfer.rail !== "sepa") throw new Error("receipts are issued for SEPA payments");
  if (transfer.state !== "PAID") {
    throw new Error(`this payment is ${transfer.state.toLowerCase().replace(/_/g, " ")}, not yet settled — a receipt is issued once it is paid`);
  }
  const [line, fee] = linesFromTransfers([transfer]);
  if (!line) throw new Error("this transfer has not moved money yet, so there is nothing to receipt");
  return {
    kind: "receipt",
    holder: holderBlock(user),
    transferId: transfer.id,
    line,
    state: transfer.state,
    ...(fee ? { feeEur: fee.amountEur } : {}),
    rail: transfer.rail,
  };
}

export async function buildBalance(user: User): Promise<BalanceSnapshot> {
  const holder = holderBlock(user);
  const block = await blockAt("latest");
  return {
    kind: "balance",
    holder,
    balanceEur: await balanceAtBlock(holder.safeAddress, block.number),
    block,
    tokenAddress: addrs().eure,
  };
}

// ---------------------------------------------------------------------------
// verification

async function verifyDocument(doc: StoredDocument): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] }> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const zold = await verifyZoldAttestation(doc);
  checks.push({ name: "Signed by Zold", ok: zold.ok, detail: zold.ok ? `signer ${doc.attestations.zold.signer}` : zold.reason });
  if (doc.revokedAt) checks.push({ name: "Not revoked", ok: false, detail: `revoked ${doc.revokedAt}` });

  if (doc.snapshot.kind === "balance") {
    try {
      const live = await balanceAtBlock(doc.snapshot.holder.safeAddress, doc.snapshot.block.number);
      const ok = Math.abs(live - doc.snapshot.balanceEur) < 0.005;
      checks.push({ name: "Balance re-read from the chain at that block", ok, detail: ok ? `€${live.toFixed(2)} at block ${doc.snapshot.block.number}` : `chain says €${live.toFixed(2)}` });
    } catch (err: any) {
      checks.push({ name: "Balance re-read from the chain at that block", ok: false, detail: `chain unavailable: ${String(err?.message ?? err).slice(0, 100)}` });
    }
  }
  if (doc.snapshot.kind === "statement" && doc.snapshot.closing) {
    try {
      const live = await balanceAtBlock(doc.snapshot.holder.safeAddress, doc.snapshot.closing.number);
      const ok = Math.abs(live - doc.snapshot.closing.amountEur) < 0.005;
      checks.push({ name: "Closing balance re-read from the chain", ok, detail: `€${live.toFixed(2)} at block ${doc.snapshot.closing.number}` });
    } catch (err: any) {
      checks.push({ name: "Closing balance re-read from the chain", ok: false, detail: `chain unavailable: ${String(err?.message ?? err).slice(0, 100)}` });
    }
    checks.push({
      name: "Lines reconcile with the balances",
      ok: doc.snapshot.reconciliation.reconciles,
      detail: doc.snapshot.reconciliation.note,
    });
  }
  const safe = doc.attestations.safe;
  if (safe) {
    if (HARNESS.enabled) {
      checks.push({ name: "Signed by the account's smart account", ok: true, detail: "recorded; not checked on the local harness chain" });
    } else {
      try {
        const ok = await publicClient.verifyMessage({ address: safe.address, message: safe.message, signature: safe.signature });
        checks.push({ name: "Signed by the account's smart account", ok, detail: ok ? `EIP-1271 valid for ${safe.address}` : "the smart account rejects this signature" });
      } catch (err: any) {
        checks.push({ name: "Signed by the account's smart account", ok: false, detail: `could not check: ${String(err?.message ?? err).slice(0, 100)}` });
      }
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// router

const pendingOwnershipSignatures = new Map<string, { userId: string; documentId: string; challenge: string; message: string; expiresAt: number }>();

export function createDocumentsRouter(deps: DocumentsDeps) {
  const router = express.Router();
  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) =>
      Promise.resolve(fn(req, res)).catch(next);

  const userFor = (req: express.Request, res: express.Response): User | undefined => {
    const user = store.findUser(req.params.id);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return undefined;
    }
    if (!deps.requireUserSession(req, res, user.id)) return undefined;
    return user;
  };

  /** No smart account, no account of record: a document naming the zero
   *  address would be a letter about an account that does not exist yet. */
  const hasAccountOfRecord = (user: User, res: express.Response): boolean => {
    if (/^0x[0-9a-fA-F]{40}$/.test(user.address) && !/^0x0{40}$/i.test(user.address)) return true;
    res.status(409).json({ error: "this account has no smart account yet — finish the passkey and smart-account setup first" });
    return false;
  };

  const issue = async (user: User, snapshot: DocumentSnapshot, safe?: StoredDocument["attestations"]["safe"]) => {
    const code = newDocumentCode();
    const doc: StoredDocument = {
      id: randomUUID(),
      code: normaliseCode(code),
      kind: snapshot.kind,
      userId: user.id,
      createdAt: new Date().toISOString(),
      snapshot,
      attestations: { zold: await signSnapshot(snapshot, code), ...(safe ? { safe } : {}) },
    };
    store.addDocument(doc);
    return doc;
  };

  router.get(
    "/users/:id/documents",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      res.json({
        documents: store
          .documentsForUser(user.id)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .map((d) => ({ ...publicDocument(d), snapshot: undefined, summary: summarise(d) })),
      });
    }),
  );

  router.post(
    "/users/:id/documents/receipt",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      if (!hasAccountOfRecord(user, res)) return;
      const transfer = store.findTransfer(String(req.body?.transferId ?? ""));
      if (!transfer || transfer.userId !== user.id) return res.status(404).json({ error: "transfer not found" });
      let snapshot: ReceiptSnapshot;
      try {
        snapshot = buildReceipt(user, transfer);
      } catch (err: any) {
        return res.status(409).json({ error: String(err?.message ?? err) });
      }
      res.status(201).json(publicDocument(await issue(user, snapshot)));
    }),
  );

  router.post(
    "/users/:id/documents/statement",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      if (!hasAccountOfRecord(user, res)) return;
      const { from, to } = periodFrom(req.body);
      if (!from || !to || from >= to) return res.status(400).json({ error: "from and to must be ISO dates with from before to" });
      if (to.getTime() - from.getTime() > 400 * 24 * 3600_000) return res.status(400).json({ error: "a statement covers at most one year" });
      const snapshot = await buildStatement(user, from, to);
      res.status(201).json(publicDocument(await issue(user, snapshot)));
    }),
  );

  router.post(
    "/users/:id/documents/balance",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      if (!hasAccountOfRecord(user, res)) return;
      const snapshot = await buildBalance(user);
      res.status(201).json(publicDocument(await issue(user, snapshot)));
    }),
  );

  /** Proof of ownership: issued at once with Zold's signature; the Safe's own
   *  signature is an optional second step the holder's passkey performs. */
  router.post(
    "/users/:id/documents/ownership",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      if (!hasAccountOfRecord(user, res)) return;
      const holder = holderBlock(user);
      const date = new Date().toISOString().slice(0, 10);
      const code = newDocumentCode();
      const snapshot: OwnershipSnapshot = {
        kind: "ownership",
        holder,
        statement: ownershipStatement(holder, date),
        safeMessage: ownershipMessage(holder, code, date),
      };
      const doc: StoredDocument = {
        id: randomUUID(),
        code: normaliseCode(code),
        kind: "ownership",
        userId: user.id,
        createdAt: new Date().toISOString(),
        snapshot,
        attestations: { zold: await signSnapshot(snapshot, code) },
      };
      store.addDocument(doc);
      const out: Record<string, unknown> = publicDocument(doc);
      const plan = user.passkeySafe;
      if (plan?.status === "active" && user.passkey?.publicKey && user.address.toLowerCase() === plan.address.toLowerCase()) {
        for (const [k, v] of pendingOwnershipSignatures) if (v.expiresAt < Date.now()) pendingOwnershipSignatures.delete(k);
        const requestId = randomUUID();
        const challenge = bufToB64url(Buffer.from(safeMessageHash(plan.address, snapshot.safeMessage).slice(2), "hex"));
        pendingOwnershipSignatures.set(requestId, { userId: user.id, documentId: doc.id, challenge, message: snapshot.safeMessage, expiresAt: Date.now() + 5 * 60_000 });
        out.safeSignature = {
          requestId,
          credentialId: user.passkey.credentialId,
          rpId: user.passkey.rpId ?? SECURITY.rpId,
          challenge,
          message: snapshot.safeMessage,
          submitTo: `/api/users/${user.id}/documents/ownership/${requestId}`,
        };
      }
      res.status(201).json(out);
    }),
  );

  router.post(
    "/users/:id/documents/ownership/:requestId",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const pending = pendingOwnershipSignatures.get(req.params.requestId);
      if (!pending || pending.userId !== user.id || pending.expiresAt < Date.now()) {
        return res.status(404).json({ error: "ownership signature request not found or expired" });
      }
      const doc = store.documents.find((d) => d.id === pending.documentId);
      if (!doc) return res.status(404).json({ error: "document not found" });
      const { authenticatorData, clientDataJSON, signature } = req.body ?? {};
      if (!authenticatorData || !clientDataJSON || !signature) {
        return res.status(400).json({ error: "authenticatorData, clientDataJSON and signature required" });
      }
      const passkey = user.passkey!;
      let signCount: number;
      try {
        ({ signCount } = await verifyAssertionForChallenge(
          authenticatorData,
          clientDataJSON,
          signature,
          passkey.publicKey!,
          passkey.signCount ?? 0,
          passkey.rpId ?? SECURITY.rpId,
          SECURITY.origins,
          pending.challenge,
          true,
        ));
      } catch (err: any) {
        return res.status(401).json({ error: String(err?.message ?? err) });
      }
      store.updateUser(user.id, { passkey: { ...passkey, signCount } });
      const plan = user.passkeySafe as PasskeySafeDeploymentPlan;
      const safeSig = await signMessageAsPasskeySafe(plan, plan.address, pending.message, {
        authenticatorData: b64urlToBuf(authenticatorData),
        clientDataJSON: b64urlToBuf(clientDataJSON),
        signature: b64urlToBuf(signature),
      });
      pendingOwnershipSignatures.delete(req.params.requestId);
      const updated = store.updateDocument(doc.id, {
        attestations: {
          ...doc.attestations,
          safe: { address: plan.address, message: pending.message, signature: safeSig, signedAt: new Date().toISOString() },
        },
      });
      res.json(publicDocument(updated));
    }),
  );

  router.delete(
    "/users/:id/documents/:code",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      const doc = store.findDocumentByCode(normaliseCode(req.params.code));
      if (!doc || doc.userId !== user.id) return res.status(404).json({ error: "document not found" });
      store.updateDocument(doc.id, { revokedAt: new Date().toISOString() });
      res.json({ revoked: true });
    }),
  );

  // ---- public verification -------------------------------------------------

  router.get(
    "/v/:code",
    wrap(async (req, res) => {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      if (!isDocumentCode(req.params.code)) return res.status(404).json({ error: "no such document" });
      const doc = store.findDocumentByCode(normaliseCode(req.params.code));
      if (!doc) return res.status(404).json({ error: "no such document" });
      const verification = await verifyDocument(doc);
      res.json({ ...publicDocument(doc), parties: PARTIES, verification, verifiedAt: new Date().toISOString(), chainId: CHAIN_ID });
    }),
  );

  return router;
}

function periodFrom(body: any): { from: Date | null; to: Date | null } {
  const parse = (v: unknown) => {
    if (typeof v !== "string" || !v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  let from = parse(body?.from);
  let to = parse(body?.to);
  if (!from && !to) {
    // Default: the previous calendar month, UTC.
    const now = new Date();
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1);
  }
  return { from, to };
}

function summarise(d: StoredDocument): string {
  const s = d.snapshot;
  if (s.kind === "statement") return `${s.period.from.slice(0, 10)} to ${s.period.to.slice(0, 10)} · ${s.lines.length} line${s.lines.length === 1 ? "" : "s"}`;
  if (s.kind === "receipt") return `€${s.line.amountEur.toFixed(2)} to ${s.line.counterpartyName ?? "—"}`;
  if (s.kind === "balance") return `€${s.balanceEur.toFixed(2)} at block ${s.block.number}`;
  return d.attestations.safe ? "signed by Zold and your smart account" : "signed by Zold";
}
