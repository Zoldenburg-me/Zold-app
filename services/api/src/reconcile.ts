/**
 * Monerium mirror reconciler.
 *
 * Money lands in the user's Safe. The local store still records which Monerium
 * issue-order ids were observed, so this flags missed or fabricated receipt
 * records without comparing against a second ledger.
 *
 * This reports drift. It deliberately does NOT repair it: every repair is a
 * balance change, and an automated system that quietly mints or burns to make
 * two ledgers agree is a worse problem than the disagreement. A human decides
 * what a discrepancy means.
 *
 * Two classes of finding:
 *
 *  - UNMIRRORED  Monerium processed a deposit we never recorded. Usually a
 *                missed webhook or a poller outage.
 *  - PHANTOM     We recorded an order Monerium has no record of. This is what
 *                a forged webhook delivery would have produced before the
 *                receiver stopped trusting request bodies.
 */
import { moneriumSandboxEnabled } from "./config.js";
import { store } from "./store.js";
import { listProcessedIssueOrders } from "./adapters/monerium-sandbox.js";

export type FindingKind = "UNMIRRORED" | "PHANTOM";

export interface Finding {
  kind: FindingKind;
  detail: string;
  /** EUR at stake, where the discrepancy has an amount. */
  amountEur?: number;
  orderId?: string;
  address?: string;
}

export interface ReconcileReport {
  at: string;
  checked: {
    moneriumOrders: number;
    mirroredOrders: number;
    users: number;
  };
  findings: Finding[];
  ok: boolean;
}

/** Compare Monerium's processed orders with the local mirror record. */
export async function reconcile(): Promise<ReconcileReport> {
  const findings: Finding[] = [];
  const mirrored = new Set(store.mirroredOrderIds());

  // --- mirror seam: Monerium's deposits vs the ones we credited ------------
  let moneriumOrders: Awaited<ReturnType<typeof listProcessedIssueOrders>> = [];
  if (moneriumSandboxEnabled()) {
    moneriumOrders = await listProcessedIssueOrders();
    const known = new Map(moneriumOrders.map((o) => [o.id, o]));

    for (const order of moneriumOrders) {
      if (mirrored.has(order.id)) continue;
      // Deposits for addresses we don't manage aren't ours to mirror.
      if (!store.findUserByAddress(order.address)) continue;
      findings.push({
        kind: "UNMIRRORED",
        detail: `Monerium processed issue order ${order.id} for ${order.address} but the app never recorded it`,
        amountEur: Number(order.amount),
        orderId: order.id,
        address: order.address,
      });
    }

    for (const id of mirrored) {
      if (known.has(id)) continue;
      findings.push({
        kind: "PHANTOM",
        detail: `app recorded order ${id}, which Monerium has no processed issue order for — record may be fabricated`,
        orderId: id,
      });
    }
  }

  return {
    at: new Date().toISOString(),
    checked: {
      moneriumOrders: moneriumOrders.length,
      mirroredOrders: mirrored.size,
      users: store.users.length,
    },
    findings,
    ok: findings.length === 0,
  };
}

/** Human-readable report, for the CLI and the periodic log line. */
export function formatReport(r: ReconcileReport): string {
  const head =
    `reconcile ${r.at}: ${r.checked.moneriumOrders} Monerium order(s), ` +
    `${r.checked.mirroredOrders} mirrored, ${r.checked.users} user(s)`;
  if (r.ok) return `${head}\n  ledgers agree`;
  const lines = r.findings.map((f) => {
    const amt = f.amountEur !== undefined ? ` (€${f.amountEur.toFixed(2)})` : "";
    return `  [${f.kind}]${amt} ${f.detail}`;
  });
  return `${head}\n${lines.join("\n")}`;
}
