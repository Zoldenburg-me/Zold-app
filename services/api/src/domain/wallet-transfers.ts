/**
 * One ERC-20 transfer touching an imported wallet, as a ledger row.
 *
 * Pure: the sync loop (wallet-sync/sync.ts) reads the chain and the price,
 * this decides what the row says. Rules for the row:
 *
 * - Direction from which side the wallet is on. A transfer with the wallet on
 *   both sides moves nothing and is skipped.
 * - The counterparty is a contact when exactly one contact lists the address
 *   on that chain. A DAO's multisig, its distributor and its stream contract
 *   are all wallets on the one contact, so a claim matches like a push. Two
 *   contacts on one address name neither: a guess books money to the wrong
 *   payer.
 * - The asset is the price feed's symbol when the token was valued, and the
 *   contract's own symbol qualified by chain and address when it was not. A
 *   token anyone can deploy may call itself USDC; unqualified, it would merge
 *   into the real USDC's tax lots.
 * - No valuation still books the row, without a value and tagged
 *   `needs-valuation`. Leaving it out would understate the wallet; valuing it
 *   at zero would understate the income.
 * - A transfer to or from another address the org holds on that chain is
 *   `internal_transfer`, which no default rule books as income or expense.
 * - A token on no curated list (`tokenClass: "unlisted"`) is booked as a
 *   quantity only: no value, no price asked, `unlisted_token` so no default
 *   rule books it as income. Anyone can airdrop a token to a Safe.
 * - The row id is the org, the wallet ADDRESS and the log, not the wallet
 *   row: removing a wallet keeps its rows (nothing in the ledger is deleted),
 *   so importing the same address again must not book them twice.
 */
import { formatUnits } from "viem";
import { lineId } from "../bookkeeping/statement.js";
import type { Contact, ImportedWallet, LedgerEntry } from "./types.js";

export interface RawTransfer {
  chainId: number;
  token: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  valueUnits: bigint;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  /** ISO time of the block. Absent only if the node would not say. */
  blockTime?: string;
}

export interface TokenInfo {
  address: `0x${string}`;
  symbol?: string;
  /** Absent when the contract would not answer: such a transfer is not booked. */
  decimals?: number;
}

export interface Valuation {
  /** Euro per one whole token. */
  eurPerUnit: number;
  eurValue: number;
  /** In words: which price, from where, through which EUR rate. */
  source: string;
  /** The day the EUR rate was fixed. */
  asOf: string;
  /** The symbol the price source knows the token by. */
  symbol: string;
}

export type TokenClass = "emoney" | "listed" | "unlisted";

export interface WalletEntryInput {
  wallet: ImportedWallet;
  /** E-money (EURe at par), a listed virtual asset, or on no list. */
  tokenClass: TokenClass;
  transfer: RawTransfer;
  token: TokenInfo;
  valuation: Valuation | undefined;
  /** Why there is no valuation, for the note. */
  valuationFailure?: string;
  contacts: Contact[];
  /** Other addresses the org holds: its imported wallets and its accounts. */
  ownAddresses?: { chainId: number; address: string }[];
  now: string;
}

export const walletEntryKey = (address: string, chainId: number, txHash: string, logIndex: number) =>
  `wallet:${chainId}:${address.toLowerCase()}:${txHash.toLowerCase()}:${logIndex}`;

export const walletEntryId = (orgId: string, address: string, chainId: number, txHash: string, logIndex: number) =>
  lineId(orgId, walletEntryKey(address, chainId, txHash, logIndex));

const lower = (a: string) => a.toLowerCase() as `0x${string}`;

/** A symbol is a label from the contract or the price feed, both untrusted.
 *  Letters, digits, dot, dash and underscore only: a bidi override or a
 *  newline inside "USDC" would spoof the asset column. Empty when nothing
 *  survives. */
export const cleanSymbol = (s: unknown): string =>
  String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);

/** `formatUnits` pads one character per decimal; uint256 has 78 digits. */
export const MAX_DECIMALS = 77;
export const usableDecimals = (d: unknown): d is number =>
  typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= MAX_DECIMALS;

function contactFor(contacts: Contact[], chainId: number, address: string): Contact | undefined {
  const hits = contacts.filter((c) =>
    c.wallets.some((w) => w.chainId === chainId && w.address.toLowerCase() === address),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

function assetFor(input: WalletEntryInput): string {
  if (input.valuation) return input.valuation.symbol;
  const symbol = cleanSymbol(input.token.symbol) || "TOKEN";
  return `${symbol}@${input.transfer.chainId}:${lower(input.transfer.token)}`;
}

export function toWalletEntry(input: WalletEntryInput): { entry: LedgerEntry } | { skip: string } {
  const { wallet, transfer, token, valuation } = input;
  const self = wallet.address.toLowerCase();
  const from = transfer.from.toLowerCase();
  const to = transfer.to.toLowerCase();
  if (from === self && to === self) return { skip: "a transfer from the wallet to itself" };
  if (from !== self && to !== self) return { skip: "the wallet is on neither side" };
  if (transfer.valueUnits <= 0n) return { skip: "a zero-value transfer" };
  if (!usableDecimals(token.decimals)) return { skip: `token ${lower(transfer.token)} did not report usable decimals` };

  const direction = to === self ? "in" : "out";
  const other = direction === "in" ? from : to;
  const contact = contactFor(input.contacts, transfer.chainId, other);
  const internal = (input.ownAddresses ?? []).some(
    (o) => o.chainId === transfer.chainId && o.address.toLowerCase() === other,
  );
  const unlisted = input.tokenClass === "unlisted";
  const txType = internal ? "internal_transfer" : unlisted ? "unlisted_token" : direction === "in" ? "transfer_in" : "transfer_out";
  const note = unlisted
    ? "Not on a token list: booked as a quantity, with no value."
    : valuation
      ? `Valued at receipt: ${valuation.source}.`
      : `Not valued: ${input.valuationFailure ?? "no price"}.`;

  const entry: LedgerEntry = {
    id: walletEntryId(wallet.orgId, wallet.address, transfer.chainId, transfer.txHash, transfer.logIndex),
    orgId: wallet.orgId,
    source: { kind: "wallet", walletId: wallet.id },
    chainId: transfer.chainId,
    txHash: transfer.txHash,
    logIndex: transfer.logIndex,
    direction,
    asset: assetFor(input),
    token: lower(transfer.token),
    amount: formatUnits(transfer.valueUnits, token.decimals),
    ...(valuation
      ? {
          fiatValue: valuation.eurValue.toFixed(2),
          fiatCurrency: "EUR",
          fiatRate: String(valuation.eurPerUnit),
        }
      : {}),
    counterparty: {
      address: other as `0x${string}`,
      ...(contact ? { contactId: contact.id, name: contact.name } : {}),
    },
    tags: [
      "wallet",
      ...(internal ? ["internal"] : []),
      ...(input.tokenClass === "emoney" ? ["e-money"] : []),
      ...(unlisted ? ["unlisted"] : valuation ? [] : ["needs-valuation"]),
    ],
    note,
    txType,
    at: transfer.blockTime ?? input.now,
    createdAt: input.now,
  };
  return { entry };
}
