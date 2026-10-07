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
 */
import type { CryptoDeposit, MoneriumIssueRecord, Transfer } from "../store/types.js";
import { userTransfer, type UserTransfer } from "./user-transfer.js";

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
      state: CryptoDeposit["state"];
      reason?: string;
      settlementAsset?: CryptoDeposit["settlementAsset"];
      detectedAt: string;
      updatedAt: string;
    }
  | { kind: "bank_in"; id: string; at: string; amountEur: number; counterpartyName?: string; memo?: string };

export interface ActivitySources {
  transfers: Transfer[];
  deposits: CryptoDeposit[];
  issues: MoneriumIssueRecord[];
}

/** An EURe mint the watcher accepted: Monerium issuing against a SEPA credit. */
const isAcceptedMint = (d: CryptoDeposit) =>
  d.token === "EURE" && Boolean(d.from && ZERO_ADDRESS.test(d.from)) && d.state !== "REFUSED" && (d.amountEur ?? 0) > 0;

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

const fundingRow = (d: CryptoDeposit): ActivityRow => ({
  kind: "funding",
  id: d.id,
  at: d.detectedAt,
  chainId: d.chainId,
  token: d.token,
  txHash: d.txHash,
  amountEur: d.amountEur ?? d.creditedEur,
  amountUsdc: d.amountUsdc ?? d.creditedUsdc,
  state: d.state,
  reason: d.reason,
  settlementAsset: d.settlementAsset,
  detectedAt: d.detectedAt,
  updatedAt: d.updatedAt,
});

/** One user's rows, newest first. The caller has already scoped every source to the user. */
export function buildActivity({ transfers, deposits, issues }: ActivitySources): ActivityRow[] {
  const unclaimed = [...issues];
  const depositRows = deposits.flatMap((d): ActivityRow[] => {
    if (!isAcceptedMint(d)) return [fundingRow(d)];
    const i = unclaimed.findIndex((o) => mintMatchesIssue(d, o));
    if (i < 0) return [bankRowFromMint(d)];
    unclaimed.splice(i, 1);
    return [];
  });
  const rows: ActivityRow[] = [
    ...transfers.map((t): ActivityRow => ({ kind: "transfer", at: t.createdAt, ...userTransfer(t) })),
    ...depositRows,
    ...issues.map(bankRowFromIssue),
  ];
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
