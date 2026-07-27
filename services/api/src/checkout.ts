/**
 * "Pay with Zold" — merchant checkout via an OAuth-style handoff.
 *
 * A partner (Mony) redirects its user to our authorize endpoint with an amount,
 * a reference, a redirect_uri and a PKCE code_challenge. We create a
 * PaymentIntent and send the user through our checkout UI, where they sign in
 * with a passkey (existing user → instant; new user → onboard) and authorize a
 * SEPA transfer into the merchant's IBAN using the same device-key flow as any
 * other payment. On success we hand the merchant a one-time code, which it
 * exchanges (with the PKCE verifier) for the payment status.
 *
 * This module is the authorization-server half; it is the mirror image of the
 * Monerium OAuth-connect flow, with us as the issuer instead of the client.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { store, type Merchant, type PaymentIntent, type Transfer } from "./store.js";

const INTENT_TTL_MS = 15 * 60_000;

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Ensure a demo merchant exists for local/sandbox runs so the flow is
 * exercisable without a real partner. Never seeded in production (guarded by
 * the caller). `redirectUris: ["*"]` is a demo-only convenience.
 */
export function seedDemoMerchant(ibanTarget = "DE89370400440532013000") {
  if (store.findMerchantByClientId("demo-merchant")) return;
  store.addMerchant({
    id: randomUUID(),
    name: "Mony (demo)",
    clientId: "demo-merchant",
    clientSecret: "demo-secret",
    ibanTarget,
    redirectUris: ["*"],
    webhookUrl: undefined,
    createdAt: new Date().toISOString(),
  });
}

export function redirectAllowed(merchant: Merchant, redirectUri: string): boolean {
  return merchant.redirectUris.includes("*") || merchant.redirectUris.includes(redirectUri);
}

export function createIntent(
  merchant: Merchant,
  args: { amountEur: number; reference: string; redirectUri: string; state: string; codeChallenge: string },
): PaymentIntent {
  const now = new Date().toISOString();
  const intent: PaymentIntent = {
    id: randomUUID(),
    merchantId: merchant.id,
    amountEur: args.amountEur,
    reference: args.reference,
    redirectUri: args.redirectUri,
    state: args.state,
    codeChallenge: args.codeChallenge,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  };
  store.addPaymentIntent(intent);
  return intent;
}

export function isIntentExpired(intent: PaymentIntent): boolean {
  return Date.now() - Date.parse(intent.createdAt) > INTENT_TTL_MS;
}

/** Terminal payout states of a transfer that count as a completed checkout. */
const SETTLED = new Set(["PAYOUT_SUBMITTED", "PAID", "PAYOUT_READY", "PAYOUT_FUNDED"]);

/**
 * Attach a user's authorized transfer to an intent and mint the one-time code.
 * Refuses unless the transfer belongs to the user, pays the merchant's IBAN,
 * matches the intent amount, and has actually left CREATED (i.e. the device
 * signature cleared) — so a merchant can never be told "paid" for a transfer
 * that hasn't been authorized.
 */
export function attachTransfer(
  intent: PaymentIntent,
  userId: string,
  transfer: Transfer,
): { redirectUrl: string } {
  if (intent.status !== "PENDING") throw new Error(`intent already ${intent.status.toLowerCase()}`);
  if (isIntentExpired(intent)) {
    store.updatePaymentIntent(intent.id, { status: "EXPIRED" });
    throw new Error("checkout expired");
  }
  const merchant = store.findMerchant(intent.merchantId);
  if (!merchant) throw new Error("merchant not found");
  if (transfer.userId !== userId) throw new Error("transfer does not belong to this user");
  if (transfer.rail !== "sepa") throw new Error("checkout transfer must be a SEPA payout");
  const norm = (s?: string) => (s ?? "").replace(/\s/g, "").toUpperCase();
  if (norm(transfer.recipientIban) !== norm(merchant.ibanTarget)) {
    throw new Error("transfer does not pay the merchant's account");
  }
  if (Math.abs((transfer.receiveEur ?? 0) - intent.amountEur) > 0.01) {
    throw new Error("transfer amount does not match the checkout");
  }
  if (!SETTLED.has(transfer.state)) {
    throw new Error(`transfer not settled (state ${transfer.state})`);
  }

  const code = randomBytes(24).toString("base64url");
  const status: PaymentIntent["status"] = transfer.state === "PAID" ? "PAID" : "AUTHORIZED";
  store.updatePaymentIntent(intent.id, { status, userId, transferId: transfer.id, code });
  const u = new URL(intent.redirectUri);
  u.searchParams.set("code", code);
  u.searchParams.set("state", intent.state);
  return { redirectUrl: u.toString() };
}

export interface IntentStatusView {
  intentId: string;
  status: PaymentIntent["status"];
  amountEur: number;
  reference: string;
  transferId?: string;
}

function statusView(intent: PaymentIntent): IntentStatusView {
  return {
    intentId: intent.id,
    status: liveStatus(intent),
    amountEur: intent.amountEur,
    reference: intent.reference,
    transferId: intent.transferId,
  };
}

/** Reflect the linked transfer's terminal state into the intent view. */
function liveStatus(intent: PaymentIntent): PaymentIntent["status"] {
  if (intent.transferId) {
    const t = store.findTransfer(intent.transferId);
    if (t?.state === "PAID") return "PAID";
    if (t && (t.state === "FAILED" || t.state === "REFUNDED")) return "FAILED";
  }
  return intent.status;
}

/**
 * Confidential token exchange: the merchant proves it started this checkout by
 * presenting the PKCE verifier for the code_challenge, plus its client secret.
 * Returns the status and a bearer for subsequent polling; burns the code.
 */
export function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
): IntentStatusView & { statusToken: string } {
  const merchant = store.findMerchantByClientId(clientId);
  if (!merchant || merchant.clientSecret !== clientSecret) throw new Error("bad client credentials");
  const intent = store.findPaymentIntentByCode(code);
  if (!intent || intent.merchantId !== merchant.id) throw new Error("unknown or used code");
  if (pkceChallenge(codeVerifier) !== intent.codeChallenge) throw new Error("PKCE verification failed");
  const statusToken = randomBytes(24).toString("base64url");
  store.updatePaymentIntent(intent.id, { code: undefined, statusToken });
  return { ...statusView(intent), statusToken };
}

export function statusByToken(intentId: string, statusToken: string): IntentStatusView {
  const intent = store.findPaymentIntent(intentId);
  if (!intent || !intent.statusToken || intent.statusToken !== statusToken) {
    throw new Error("unknown intent or bad token");
  }
  return statusView(intent);
}

export { statusView };
