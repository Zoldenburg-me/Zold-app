/**
 * The personal activity feed: transfers out, crypto deposits, and bank
 * transfers in.
 *
 * A bank transfer in is a Monerium `issue` order (the poller keeps its facts in
 * `moneriumIssueOrders`). The same deposit also reaches the Safe as an EURe
 * mint, which the chain watcher records as a crypto deposit from the zero
 * address. Each mint is absorbed by at most one order of the same amount within
 * a day (the statement's `mergeLines` rule), so a deposit is listed once. A
 * mint with no recorded order is still a bank transfer: only Monerium mints
 * EURe. The payer's IBAN stays server-side.
 *
 * Converting held USDC lands EURe on the Safe from the venue, and the watcher
 * sees that Transfer like any other. It is the user's own money changing
 * form, not money in, so an EURe deposit made by a recorded conversion is not
 * listed; the converted USDC row says what it became.
 */
import type { CryptoDeposit, CryptoSend, MoneriumIssueRecord, Transfer } from "../store/types.js";
import { userTransfer, type UserTransfer } from "./user-transfer.js";
import { conversionOutputs } from "./conversion-outputs.js";

const ZERO_ADDRESS = /^0x0{40}$/i;
const DAY_MS = 24 * 3600_000;
const SAME_AMOUNT_EUR = 0.005;

export type ActivityRow =
  | ({ kind: "transfer"; at: string } & UserTransfer)
  | {
      kind: "funding";
      id: string;
      at: string;
      chainId: number;
      token: CryptoDeposit["token"];
      txHash: string;
      amountEur?: number;
      amountUsdc?: number;
      /** Who sent it; the zero address is a Monerium mint. */
      from?: string;
      /** The block time, when the chain recorded it. */
      arrivedAt?: string;
      holding: CryptoDeposit["holding"];
      /** What a conversion delivered, measured, and its transaction. */
      creditedEur?: number;
      conversionTxHash?: string;
      convertedAt?: string;
      settledAt?: string;
      reason?: string;
      settlementAsset?: CryptoDeposit["settlementAsset"];
      detectedAt: string;
      updatedAt: string;
    }
  | { kind: "bank_in"; id: string; at: string; amountEur: number; counterpartyName?: string; memo?: string }
  | ({ kind: "crypto_out"; at: string } & Omit<CryptoSend, "userId" | "capEur">);

export interface ActivitySources {
  transfers: Transfer[];
  deposits: CryptoDeposit[];
  issues: MoneriumIssueRecord[];
  cryptoSends?: CryptoSend[];
}

/** A crypto send once its passkey approved it; an unsigned one never moved. */
function cryptoOutRow({ userId: _u, capEur: _c, ...s }: CryptoSend): ActivityRow {
  return { kind: "crypto_out", at: s.createdAt, ...s };
}

/** An EURe mint the watcher accepted: Monerium issuing against a SEPA credit. */
const isAcceptedMint = (d: CryptoDeposit) =>
  d.token === "EURE" && Boolean(d.from && ZERO_ADDRESS.test(d.from)) && d.holding !== "refused" && (d.amountEur ?? 0) > 0;

const mintMatchesIssue = (d: CryptoDeposit, o: MoneriumIssueRecord) =>
  Math.abs((d.amountEur ?? 0) - o.amountEur) < SAME_AMOUNT_EUR &&
  Math.abs(Date.parse(d.arrivedAt ?? d.detectedAt) - Date.parse(o.processedAt)) <= DAY_MS;

const bankRowFromIssue = (o: MoneriumIssueRecord): ActivityRow => ({
  kind: "bank_in",
  id: o.orderId,
  at: o.processedAt,
  amountEur: o.amountEur,
  ...(o.counterpartyName ? { counterpartyName: o.counterpartyName } : {}),
  ...(o.memo ? { memo: o.memo } : {}),
});

const bankRowFromMint = (d: CryptoDeposit): ActivityRow => ({
  kind: "bank_in",
  id: d.id,
  at: d.arrivedAt ?? d.detectedAt,
  amountEur: d.amountEur!,
});

/** Deposits that are money in: every one but a conversion's EURe output. */
export function withoutConversionOutputs(deposits: CryptoDeposit[]): CryptoDeposit[] {
  const isConversionOutput = conversionOutputs(deposits);
  return deposits.filter((d) => !(d.token === "EURE" && isConversionOutput(d.txHash, d.logIndex, d.userId)));
}

const fundingRow = (d: CryptoDeposit): ActivityRow => ({
  kind: "funding",
  id: d.id,
  at: d.detectedAt,
  chainId: d.chainId,
  token: d.token,
  txHash: d.txHash,
  amountEur: d.amountEur ?? d.creditedEur,
  amountUsdc: d.amountUsdc ?? d.creditedUsdc,
  ...(d.from ? { from: d.from } : {}),
  ...(d.arrivedAt ? { arrivedAt: d.arrivedAt } : {}),
  holding: d.holding,
  ...(d.token === "USDC" && d.holding === "converted" && typeof d.creditedEur === "number"
    ? { creditedEur: d.creditedEur, conversionTxHash: d.conversion?.txHash, convertedAt: d.conversion?.at }
    : {}),
  settledAt: d.settledAt,
  reason: d.reason,
  settlementAsset: d.settlementAsset,
  detectedAt: d.detectedAt,
  updatedAt: d.updatedAt,
});

/** One user's rows, newest first. The caller has already scoped every source to the user. */
export function buildActivity({ transfers, deposits, issues, cryptoSends = [] }: ActivitySources): ActivityRow[] {
  const unclaimed = [...issues];
  const depositRows = withoutConversionOutputs(deposits).flatMap((d): ActivityRow[] => {
    if (!isAcceptedMint(d)) return [fundingRow(d)];
    const i = unclaimed.findIndex((o) => mintMatchesIssue(d, o));
    if (i < 0) return [bankRowFromMint(d)];
    unclaimed.splice(i, 1);
    return [];
  });
  const rows: ActivityRow[] = [
    // Unsigned CREATED moved no money, so it is not activity. A signed one
    // stays CREATED while its debit is relayed and must stay listed.
    ...transfers.filter((t) => t.state !== "CREATED" || t.auth?.authorizedAt || t.moneriumRedeem?.signedAt)
      .map((t): ActivityRow => ({ kind: "transfer", at: t.createdAt, ...userTransfer(t) })),
    ...depositRows,
    ...issues.map(bankRowFromIssue),
    ...cryptoSends.filter((c) => c.state !== "CREATED").map(cryptoOutRow),
  ];
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
