/**
 * Proof that an imported wallet is the organisation's: the rules, pure.
 *
 * Importing an address claims nothing. A wallet is proven by a signature,
 * made in the wallet, over a challenge Zold issues: one text naming the
 * organisation, the address and the chain, with a random id and an expiry.
 * The chain decides whether the signature is valid (wallet-sync/ownership.ts).
 *
 * - One challenge per wallet at a time; a new one replaces it. It is spent by
 *   the proof it produces, so a signature proves one wallet of one
 *   organisation on one chain, once.
 * - A proof is kept with what was signed, so it can be checked again. A
 *   check the chain refuses makes it `lapsed`; nothing is deleted.
 * - What a proof gates is read at use: collecting receipts into drafts and
 *   issuing them. Sync and the books never ask.
 *
 * Zold holds no key here and proposes no transaction: the person signs in
 * their own wallet and the chain is asked.
 */
import { getAddress } from "viem";
import type { ImportedWallet, Organisation, WalletOwnershipChallenge } from "./types.js";

/** Long enough for a Safe's owners to collect their signatures. */
export const CHALLENGE_TTL_MS = 72 * 3600_000;

export type ProofState = "proven" | "lapsed" | "unproven";

export function proofStateOf(wallet: ImportedWallet | undefined): ProofState {
  if (!wallet?.ownership) return "unproven";
  return wallet.ownership.status === "proven" ? "proven" : "lapsed";
}

const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);

/** The text to sign. Everything a replay would need to change is in it. */
export function ownershipChallengeText(input: {
  org: Pick<Organisation, "id" | "name" | "legalName">;
  wallet: Pick<ImportedWallet, "address" | "chainId">;
  id: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return [
    "Zold: proof of wallet ownership",
    "",
    "This wallet belongs to the organisation below, which may book and invoice what it receives.",
    "",
    // A name is the organisation's own text: one line, no control characters,
    // so it cannot draw a second "Organisation id:" line into the text.
    `Organisation: ${oneLine(input.org.legalName || input.org.name)}`,
    `Organisation id: ${input.org.id}`,
    `Wallet: ${getAddress(input.wallet.address)}`,
    `Network: chain id ${input.wallet.chainId}`,
    `Challenge: ${input.id}`,
    `Issued: ${input.issuedAt}`,
    `Valid until: ${input.expiresAt}`,
    "",
    "Signing this moves no funds and approves no transaction.",
  ].join("\n");
}

export function newChallenge(
  org: Pick<Organisation, "id" | "name" | "legalName">,
  wallet: Pick<ImportedWallet, "address" | "chainId">,
  id: string,
  now: Date,
): WalletOwnershipChallenge {
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
  return { id, issuedAt, expiresAt, message: ownershipChallengeText({ org, wallet, id, issuedAt, expiresAt }) };
}

/** A signature as the request may carry it: hex, at most 8 KiB (a Safe with
 *  many owners, or a wallet not yet deployed, needs more than 65 bytes).
 *  Absent is "0x", the Safe that signed the message on chain. */
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2}){0,8192}$/;
export function parseSignature(raw: unknown): `0x${string}` | undefined {
  if (raw === undefined || raw === null || raw === "") return "0x";
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  return SIGNATURE_RE.test(s) ? (s.toLowerCase() as `0x${string}`) : undefined;
}

/** The wallet row as the API shows it: the stored row plus its state. */
export const publicWallet = (wallet: ImportedWallet) => ({ ...wallet, proofState: proofStateOf(wallet) });
