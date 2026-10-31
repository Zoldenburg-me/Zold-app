/**
 * Prototype: an AI agent pays a Shopify order's Zold pay link from EURe.
 *
 * Reads the order's public pay JSON (the link from the order confirmation
 * email, or the pay page URL), checks it against the agent's mandate, and
 * prints the Monerium payout the agent would place: an EUR redeem to the
 * payee's IBAN with the request code as the memo, which is how Zold
 * attributes the credit and the checkout marks the order paid. Needs the
 * shop linked with MERCHANT_LINK_BANK=1 so the order takes a bank transfer.
 *
 * It signs and sends nothing. In the hackathon design the NEAR mandate
 * contract (shape 3) signs the payout message; the checks here are only the
 * readable pre-check, the contract is the source of truth.
 *
 * Run: npx tsx scripts/agent-pay-shopify.ts <pay link> --origin https://checkout.example
 *        --origin https://zold.example --max-eur 50 --iban DE89...
 * Every --origin is trusted to serve the link or the pay page; nothing else is fetched.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moneriumRedeemMessage, normalizeIban } from "../services/api/src/sepa.js";

export type Mandate = { maxEur: number; ibans: string[] };

/** The public pay JSON fields this reads (publicPaymentRequest). */
export type PayView = {
  state: string;
  outstandingEur?: number;
  expiresAt?: string;
  methods: { bank?: { iban: string; holder: string; reference: string } };
};

export type Plan =
  | { ok: true; payout: { amount: string; currency: "eur"; counterpart: { iban: string; name: string }; memo: string; message: string; issuedAt: string } }
  | { ok: false; reason: string };

/** The pay JSON comes from the network: take only well-formed fields. */
export function parsePayView(raw: unknown): PayView {
  const o = (raw ?? {}) as Record<string, any>;
  if (typeof o.state !== "string") throw new Error("pay page: no state");
  const view: PayView = { state: o.state, methods: {} };
  if (o.outstandingEur !== undefined) {
    if (typeof o.outstandingEur !== "number" || !Number.isFinite(o.outstandingEur)) throw new Error("pay page: bad outstandingEur");
    view.outstandingEur = o.outstandingEur;
  }
  if (typeof o.expiresAt === "string") view.expiresAt = o.expiresAt;
  const b = o.methods?.bank;
  if (b !== undefined) {
    if (typeof b?.iban !== "string" || typeof b.holder !== "string" || !/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(b.reference ?? "")) {
      throw new Error("pay page: malformed bank method");
    }
    view.methods.bank = { iban: b.iban, holder: b.holder, reference: b.reference };
  }
  return view;
}

export function planAgentPayment(view: PayView, mandate: Mandate, now = new Date()): Plan {
  if (view.state !== "OPEN") return { ok: false, reason: `the request is ${view.state.toLowerCase()}` };
  if (view.expiresAt && !(Date.parse(view.expiresAt) > now.getTime())) return { ok: false, reason: "the request has expired" };
  const bank = view.methods.bank;
  if (!bank) return { ok: false, reason: "the request takes no bank transfer (the shop needs MERCHANT_LINK_BANK=1 and an IBAN)" };
  const due = view.outstandingEur;
  if (due === undefined || !(due > 0)) return { ok: false, reason: "the request names no amount due" };
  if (!(due <= mandate.maxEur)) return { ok: false, reason: `€${due.toFixed(2)} is over the mandate's €${mandate.maxEur.toFixed(2)} per payment` };
  if (!mandate.ibans.map(normalizeIban).includes(normalizeIban(bank.iban))) return { ok: false, reason: "the payee IBAN is not on the mandate's allowlist" };
  // Monerium checks the signed timestamp is recent; RFC3339 to the second.
  const signed = moneriumRedeemMessage(due, bank.iban, now.toISOString().replace(/\.\d{3}Z$/, "Z"));
  return {
    ok: true,
    payout: {
      amount: signed.amount,
      currency: "eur",
      counterpart: { iban: signed.iban, name: bank.holder },
      // Not covered by `message`: Monerium's signed text has no memo field,
      // so whoever submits the order could swap the code and book the credit
      // to another of this merchant's orders. The submitter must be the agent itself,
      // and the mandate contract must record the code with its reservation.
      // The code alone: matchMoneriumOrder looks for it in the memo, and
      // nothing the merchant names can push it past a length limit.
      memo: bank.reference,
      message: signed.message,
      issuedAt: signed.issuedAt,
    },
  };
}

/** The email link 302s to the pay page; the pay page's JSON is under /api. */
async function payView(link: string, origins: string[]): Promise<PayView> {
  const trusted = (u: URL) => {
    if (!origins.includes(u.origin)) throw new Error(`not a trusted origin: ${u.origin}`);
    return u;
  };
  const first = await fetch(trusted(new URL(link)), { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const page = first.status >= 300 && first.status < 400 ? trusted(new URL(first.headers.get("location") ?? "", link)) : new URL(link);
  if (!page.pathname.startsWith("/pay/")) throw new Error(`not a Zold pay link: ${page.origin}${page.pathname}`);
  const res = await fetch(`${page.origin}/api${page.pathname}`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`pay page answered ${res.status}`);
  return parsePayView(await res.json());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [link, ...args] = process.argv.slice(2);
  const values = (flag: string) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
  const maxEur = Number(values("--max-eur")[0]);
  const ibans = values("--iban");
  const origins = values("--origin").map((o) => new URL(o).origin);
  if (!link || !Number.isFinite(maxEur) || !(maxEur > 0) || ibans.length === 0 || origins.length === 0) {
    console.error("usage: npx tsx scripts/agent-pay-shopify.ts <pay link> --origin <https origin>... --max-eur 50 --iban DE89... [--iban ...]");
    process.exit(2);
  }
  try {
    const plan = planAgentPayment(await payView(link, origins), { maxEur, ibans });
    console.log(JSON.stringify(plan, null, 2));
    process.exit(plan.ok ? 0 : 1);
  } catch (e) {
    console.error(`agent-pay: ${(e as Error).message}`);
    process.exit(2);
  }
}
