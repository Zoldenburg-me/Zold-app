/**
 * Account documents — receipt, statement, balance confirmation, proof of
 * ownership. What a person hands to a landlord, an employer, a tax adviser or
 * a bank that asks "show me".
 *
 * WHAT EVERY DOCUMENT IS. A frozen snapshot of facts, stored under an
 * unguessable verification code, signed by this server's document key, and
 * re-checkable at /v/<code>. The PDF is the browser's print of the page — the
 * same route Rebind's receipt takes (their PDF's producer is Chromium) — so
 * the document is never something only a file claims; the page is the record
 * and the file is a picture of it.
 *
 * WHO IS WHO, named as Monerium's own terms name them (personal and business
 * ToS, s. 1.1 and s. 5): Monerium is the e-money issuer; the IBAN and the
 * SEPA payment services are provided by AS LHV Pank, Tallinn; Zold is
 * software. A document that says "Bank: Zold" or "Bank: Monerium" would be
 * wrong on both counts, and a balance confirmation must say that the balance
 * is e-money redeemable at par, safeguarded, and not a bank deposit (s. 4 and
 * s. 6). Those sentences are part of the data, not decoration.
 *
 * WHERE THE NUMBERS COME FROM, in order of authority:
 *   1. the chain — every EURe movement is a token transfer on the Safe, and a
 *      balance is `balanceOf` at a block. A statement's opening and closing
 *      balances are read there, so they reconcile by construction or the
 *      document says by how much they do not;
 *   2. Monerium's orders — the human side of each SEPA movement: counterparty
 *      name, IBAN, memo. The statement is honest about which lines carry it;
 *   3. our transfer records — recipient, fee, memo, state.
 */
import { createHash, randomBytes } from "node:crypto";
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, KEYS, PUBLIC_URL } from "./config.js";
import type { Transfer, User } from "./store.js";
import { paymentMemo } from "./sepa.js";

export type DocumentKind = "receipt" | "statement" | "balance" | "ownership";

/** Who stands behind what — one paragraph, once, at the foot of every
 *  document (Monerium's terms, s. 1.1 and s. 5). */
export const PARTIES = {
  footer:
    "Euros on this account are e-money (EURe) issued by Monerium ehf., Reykjavík, an Electronic Money " +
    "Institution authorised by the Financial Supervisory Authority of the Central Bank of Iceland " +
    "(No. 550512-1060). The IBAN and SEPA payments are provided by AS LHV Pank, Tallinn, Estonia. " +
    "Zold is software and holds no licence of its own.",
} as const;

/** LHV's BIC, shown only next to an Estonian IBAN it actually applies to. */
export const LHV_BIC = "LHVBEE22";
export const bicFor = (iban?: string) => (iban && /^EE/i.test(iban.replace(/\s/g, "")) ? LHV_BIC : undefined);

/** Verification codes: 15 Crockford characters (~75 bits), grouped for
 *  reading aloud. Holding one is the whole authorisation to read the page. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newDocumentCode(): string {
  const bytes = randomBytes(15);
  let out = "";
  for (let i = 0; i < 15; i++) out += CROCKFORD[bytes[i] % 32];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10)}`;
}
export const normaliseCode = (raw: string) =>
  raw.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
export const isDocumentCode = (raw: string) => /^[0-9A-HJKMNP-TV-Z]{15}$/.test(normaliseCode(raw));

// ---------------------------------------------------------------------------
// snapshots

export interface HolderBlock {
  name: string;
  addressLines: string[];
  iban?: string;
  bic?: string;
  safeAddress: `0x${string}`;
  chainId: number;
  accountSince: string;
}

export interface StatementLine {
  at: string;
  direction: "in" | "out";
  amountEur: number;
  counterpartyName?: string;
  counterpartyIban?: string;
  memo?: string;
  /** Where the facts on this line came from. */
  source: "monerium" | "transfer" | "chain";
  reference?: string;
  txHash?: string;
}

export interface StatementSnapshot {
  kind: "statement";
  holder: HolderBlock;
  period: { from: string; to: string };
  opening: { amountEur: number; number: number; hash?: string; at: string } | null;
  closing: { amountEur: number; number: number; hash?: string; at: string } | null;
  lines: StatementLine[];
  totals: { inEur: number; outEur: number };
  /** opening + in − out − closing. Zero when the statement is complete. */
  reconciliation: { reconciles: boolean; deltaEur: number; note?: string };
  sources: { chain: "ok" | string; monerium: "ok" | string; transfers: "ok" };
}

export interface ReceiptSnapshot {
  kind: "receipt";
  holder: HolderBlock;
  transferId: string;
  line: StatementLine;
  state: string;
  feeEur?: number;
  rail: string;
}

export interface BalanceSnapshot {
  kind: "balance";
  holder: HolderBlock;
  balanceEur: number;
  block: { number: number; hash?: string; at: string };
  tokenAddress: `0x${string}`;
}

export interface OwnershipSnapshot {
  kind: "ownership";
  holder: HolderBlock;
  statement: string;
  /** The exact text the account's Safe signs, when the holder chooses to. */
  safeMessage: string;
}

export type DocumentSnapshot = StatementSnapshot | ReceiptSnapshot | BalanceSnapshot | OwnershipSnapshot;

export interface DocumentAttestations {
  zold: { signer: `0x${string}`; signature: Hex; digest: Hex; signedAt: string };
  safe?: { address: `0x${string}`; message: string; signature: Hex; signedAt: string; verified?: boolean };
}

export interface StoredDocument {
  id: string;
  code: string;
  kind: DocumentKind;
  userId: string;
  createdAt: string;
  snapshot: DocumentSnapshot;
  attestations: DocumentAttestations;
  revokedAt?: string;
}

// ---------------------------------------------------------------------------
// holder

/** The person on the letterhead. Zold holds no postal address for an
 *  account — the stored Travel Rule profile that once carried one was
 *  removed for data minimisation, and Monerium keeps the KYC record — so
 *  the address block is the account country alone. A missing address
 *  prints as absent, never as a placeholder that looks like data. */
export function holderBlock(user: User): HolderBlock {
  const lines: string[] = [];
  if (user.country) lines.push(user.country.toUpperCase());
  const iban = user.iban || undefined;
  return {
    name: user.name,
    addressLines: lines,
    ...(iban ? { iban, bic: bicFor(iban) } : {}),
    safeAddress: user.address as `0x${string}`,
    chainId: CHAIN_ID,
    accountSince: user.createdAt,
  };
}

// ---------------------------------------------------------------------------
// statement lines from the three sources

export interface MoneriumOrderLike {
  id: string;
  kind: "issue" | "redeem";
  amount: string;
  address?: string;
  memo?: string;
  state?: string;
  meta?: { state?: string; placedAt?: string; processedAt?: string; [k: string]: any };
  counterpart?: {
    identifier?: { standard?: string; iban?: string; [k: string]: any };
    details?: { name?: string; firstName?: string; lastName?: string; companyName?: string; [k: string]: any };
  };
  [k: string]: any;
}

const orderProcessed = (o: MoneriumOrderLike) => (o.meta?.state ?? o.state) === "processed";
const orderAt = (o: MoneriumOrderLike) => o.meta?.processedAt ?? o.meta?.placedAt ?? o.placedAt ?? o.createdAt ?? "";
const counterpartName = (o: MoneriumOrderLike) => {
  const d = o.counterpart?.details ?? {};
  return d.name || d.companyName || [d.firstName, d.lastName].filter(Boolean).join(" ") || undefined;
};

export function linesFromMoneriumOrders(orders: MoneriumOrderLike[], safeAddress: string): StatementLine[] {
  return orders
    .filter((o) => orderProcessed(o) && (!o.address || o.address.toLowerCase() === safeAddress.toLowerCase()))
    .map((o) => ({
      at: orderAt(o),
      direction: (o.kind === "issue" ? "in" : "out") as "in" | "out",
      amountEur: Number(o.amount),
      counterpartyName: counterpartName(o),
      counterpartyIban: o.counterpart?.identifier?.iban,
      memo: o.memo,
      source: "monerium" as const,
      reference: o.id,
    }))
    .filter((l) => Number.isFinite(l.amountEur) && l.amountEur > 0 && l.at);
}

/** Money that actually left on the SEPA rail: a transfer whose fee debit or
 *  payout is on record. CREATED and FAILED transfers moved nothing. */
const SEPA_LEFT_STATES = new Set(["DEBITED", "PAYOUT_SUBMITTED", "PAID", "MANUAL_REVIEW"]);

export function linesFromTransfers(transfers: Transfer[]): StatementLine[] {
  const out: StatementLine[] = [];
  for (const t of transfers) {
    if (t.rail !== "sepa" || !SEPA_LEFT_STATES.has(t.state)) continue;
    const payoutEur = t.receiveEur ?? t.sendEur;
    out.push({
      at: t.updatedAt ?? t.createdAt,
      direction: "out",
      amountEur: Math.round(payoutEur * 100) / 100,
      counterpartyName: t.recipientName,
      counterpartyIban: t.recipientIban,
      memo: t.moneriumRedeem?.memo ?? paymentMemo(t.id, t.reference),
      source: "transfer",
      reference: t.sepa?.orderId ?? t.id,
    });
    const feeEur = Math.round((t.sendEur - payoutEur) * 100) / 100;
    if (feeEur > 0) {
      out.push({
        at: t.updatedAt ?? t.createdAt,
        direction: "out",
        amountEur: feeEur,
        counterpartyName: "Zold",
        memo: `Zold fee for ${t.id.replace(/-/g, "").slice(0, 8)}`,
        source: "transfer",
        reference: t.id,
      });
    }
  }
  return out;
}

export interface ChainCreditLike {
  txHash: string;
  amountEur?: number;
  detectedAt: string;
  token: string;
  state?: string;
}

export function linesFromChainCredits(credits: ChainCreditLike[]): StatementLine[] {
  return credits
    .filter((c) => c.token === "EURE" && (c.amountEur ?? 0) > 0)
    .map((c) => ({
      at: c.detectedAt,
      direction: "in" as const,
      amountEur: c.amountEur!,
      counterpartyName: "SEPA credit via Monerium",
      source: "chain" as const,
      txHash: c.txHash,
    }));
}

/**
 * Merge the three sources into one list, most authoritative wins.
 *
 * A Monerium issue order and the chain credit it minted are the SAME money
 * seen twice; so are a redeem order and our transfer record. Duplicates are
 * matched by amount within a day of each other and the richer line (the one
 * with a counterparty) is kept. Anything unmatched stays: a chain credit with
 * no order behind it is still a credit, and the line says only what it knows.
 */
export function mergeLines(
  monerium: StatementLine[],
  transfers: StatementLine[],
  chain: StatementLine[],
): StatementLine[] {
  const DAY = 24 * 3600_000;
  const close = (a: StatementLine, b: StatementLine) =>
    a.direction === b.direction &&
    Math.abs(a.amountEur - b.amountEur) < 0.005 &&
    Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= DAY;
  const kept: StatementLine[] = [...monerium];
  for (const t of transfers) {
    const dup = kept.find((m) => m.source === "monerium" && (m.reference === t.reference || close(m, t)));
    if (dup) {
      // Our record knows the memo and recipient as typed; Monerium's knows
      // what settled. Fill gaps, never overwrite.
      dup.memo ??= t.memo;
      dup.counterpartyName ??= t.counterpartyName;
      dup.counterpartyIban ??= t.counterpartyIban;
    } else kept.push(t);
  }
  for (const c of chain) {
    if (!kept.some((k) => k.source !== "chain" && close(k, c))) kept.push(c);
  }
  return kept.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function statementTotals(lines: StatementLine[]) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    inEur: r2(lines.filter((l) => l.direction === "in").reduce((s, l) => s + l.amountEur, 0)),
    outEur: r2(lines.filter((l) => l.direction === "out").reduce((s, l) => s + l.amountEur, 0)),
  };
}

export function reconcile(
  opening: number | null,
  closing: number | null,
  totals: { inEur: number; outEur: number },
): StatementSnapshot["reconciliation"] {
  if (opening === null || closing === null) {
    return { reconciles: false, deltaEur: 0, note: "balances could not be read from the chain, so the lines are unverified" };
  }
  const delta = Math.round((opening + totals.inEur - totals.outEur - closing) * 100) / 100;
  if (Math.abs(delta) < 0.005) return { reconciles: true, deltaEur: 0 };
  return {
    reconciles: false,
    deltaEur: delta,
    note:
      delta > 0
        ? `€${delta.toFixed(2)} left the account without a line here (a movement no source recorded)`
        : `€${(-delta).toFixed(2)} arrived without a line here (a movement no source recorded)`,
  };
}

// ---------------------------------------------------------------------------
// attestation

/** Canonical bytes of a snapshot: sorted keys, no whitespace, so the same
 *  facts always hash the same and a re-ordered JSON cannot dodge the check. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as object).filter((k) => (value as any)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function snapshotDigest(snapshot: DocumentSnapshot): Hex {
  return keccak256(toBytes(canonical(snapshot)));
}

/** The document key: DOCUMENT_SIGNING_KEY, or the orchestrator key. Signs an
 *  EIP-191 message naming the digest, so any Ethereum tool can recover the
 *  signer and a reader can compare it with the address printed on the page. */
function documentSigner() {
  const key = (process.env.DOCUMENT_SIGNING_KEY as `0x${string}` | undefined) ?? KEYS.orchestrator;
  return privateKeyToAccount(key);
}

export const attestationMessage = (digest: Hex, code: string) =>
  `Zold account document ${normaliseCode(code)} — content digest ${digest}`;

export async function signSnapshot(snapshot: DocumentSnapshot, code: string): Promise<DocumentAttestations["zold"]> {
  const account = documentSigner();
  const digest = snapshotDigest(snapshot);
  const signature = await account.signMessage({ message: attestationMessage(digest, code) });
  return { signer: account.address, signature, digest, signedAt: new Date().toISOString() };
}

export async function verifyZoldAttestation(doc: StoredDocument): Promise<{ ok: boolean; reason?: string }> {
  const { verifyMessage } = await import("viem");
  const digest = snapshotDigest(doc.snapshot);
  if (digest !== doc.attestations.zold.digest) return { ok: false, reason: "the stored content no longer matches its digest" };
  const ok = await verifyMessage({
    address: doc.attestations.zold.signer,
    message: attestationMessage(digest, doc.code),
    signature: doc.attestations.zold.signature,
  });
  return ok ? { ok: true } : { ok: false, reason: "the signature does not verify for the printed signer" };
}

/** The text a Safe signs for proof of ownership. Names the account, the code
 *  and the day, so a signature cannot be lifted onto another document. */
export function ownershipMessage(holder: HolderBlock, code: string, date: string): string {
  return (
    `I control the Zold account ${holder.safeAddress} on chain ${holder.chainId}` +
    (holder.iban ? `, linked to IBAN ${holder.iban.replace(/\s/g, "")}` : "") +
    `. Proof of ownership ${normaliseCode(code)}, ${date}.`
  );
}

export function ownershipStatement(holder: HolderBlock, date: string): string {
  return (
    `This confirms that ${holder.name} holds a Zold account, opened on ${holder.accountSince.slice(0, 10)}, ` +
    `whose account of record is the smart account ${holder.safeAddress} on chain ${holder.chainId}` +
    (holder.iban ? `, to which the IBAN ${holder.iban} is linked` : "") +
    `. Issued ${date}.`
  );
}

export const documentUrl = (code: string) => `${PUBLIC_URL || ""}/v/${normaliseCode(code)}`;

/** Public projection: everything except the id. The code is the credential. */
export function publicDocument(doc: StoredDocument) {
  const { id, userId, ...pub } = doc;
  return { ...pub, url: documentUrl(doc.code) };
}

export const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
