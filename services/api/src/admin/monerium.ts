/**
 * Everything Zold knows from Monerium, for the operator.
 *
 * STORED is what Zold kept: the connect snapshot (profiles, IBANs, addresses),
 * IBAN moves, refusals, the bank facts of issue
 * orders, the redeem orders behind SEPA payouts and the partner audit trail.
 * Never a token or a secret, nor their ciphertext.
 *
 * LIVE is a read made on the operator's request with the account's OWN
 * Monerium connection (OAuth or API keys), returned and not stored. It is
 * refused for an account without one: the app's credentials would answer with
 * every app-provisioned account's orders, not this person's. Each live read is
 * audited, because it is the operator looking into someone's bank data.
 */
import { CHAIN_ID, MONERIUM, SECURITY, moneriumOAuthEnabled, moneriumSandboxEnabled } from "../config.js";
import { store, type User } from "../store.js";
import { dataEncryptionProblem } from "../config/data-keys.js";
import { auditEntry } from "../audit.js";
import {
  connectionMethod,
  moneriumClientFor,
  moneriumEnvironment,
  publicApiKeys,
} from "../adapters/monerium-connection.js";
import { MoneriumApiError } from "../adapters/monerium-client.js";
import { checkConnection } from "../adapters/monerium-sandbox.js";
import { moneriumProfileState } from "./onboarding.js";
import { maskIdentifier } from "./mask.js";

const asList = (v: any, key: string): any[] => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);

/** The Monerium-facing facts of the deployment itself. */
export function moneriumDeployment() {
  return {
    environment: moneriumEnvironment(),
    baseUrl: MONERIUM.baseUrl,
    chain: MONERIUM.chain,
    chainId: CHAIN_ID,
    appCredentials: moneriumSandboxEnabled(),
    oauth: moneriumOAuthEnabled(),
    redirectUri: MONERIUM.redirectUri,
    webhookSecret: Boolean(SECURITY.moneriumWebhookSecret),
    pollMs: MONERIUM.pollMs,
    tokenEncryption: dataEncryptionProblem() === null,
  };
}

/** One account's Monerium row for the overview table. */
export function moneriumAccountRow(u: User) {
  const m = u.monerium;
  return {
    userId: u.id,
    name: u.name,
    email: u.email,
    kycStatus: u.kycStatus,
    method: connectionMethod(u),
    connectedAt: m?.connectedAt,
    profileId: m?.profileId ?? u.funding?.moneriumProfileId,
    profileState: moneriumProfileState(u),
    iban: u.iban || undefined,
    bic: u.ibanBic?.bic,
    fundingStatus: u.funding?.status,
    fundingDetail: u.funding?.detail,
    addressUnlinkable: u.funding?.addressUnlinkable,
    ibans: asList(m?.ibans, "ibans").length,
    addresses: asList(m?.addresses, "addresses").length,
    refusal: u.moneriumRefusal,
  };
}

/** Every SEPA payout's redeem order, as Zold recorded it. */
function redeemOrdersOf(userId?: string) {
  return store.transfers
    .filter((t) => t.rail === "sepa" && (!userId || t.userId === userId))
    .map((t) => ({
      transferId: t.id,
      userId: t.userId,
      orderId: t.sepa?.orderId,
      state: t.sepa?.state,
      detail: t.sepa?.detail,
      transferState: t.state,
      amountEur: t.sendEur,
      receiveEur: t.receiveEur,
      recipientName: t.recipientName,
      recipientIban: maskIdentifier(t.recipientIban),
      memo: t.moneriumRedeem?.memo,
      signedAt: t.moneriumRedeem?.signedAt,
      error: t.error,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function moneriumAudit(userId?: string, limit = 200) {
  return store
    .auditFor(userId, 2000)
    .filter((e) => e.kind.startsWith("partner.") || e.kind.startsWith("account.monerium") || e.kind.startsWith("operator.monerium"))
    .filter((e) => !e.data?.partner || e.data.partner === "monerium")
    .slice(0, limit);
}

/** What Zold stored for one account. */
export function storedMonerium(u: User) {
  const m = u.monerium;
  return {
    row: moneriumAccountRow(u),
    connection: m
      ? {
          method: connectionMethod(u),
          connectedAt: m.connectedAt,
          profileId: m.profileId,
          tokenExpiresAt: m.expiresAt,
          ...(m.apiKeys ? { apiKeys: publicApiKeys(m.apiKeys) } : {}),
        }
      : null,
    profiles: asList(m?.profiles, "profiles"),
    ibans: asList(m?.ibans, "ibans"),
    addresses: asList(m?.addresses, "addresses"),
    funding: u.funding,
    ibanBic: u.ibanBic,
    ibanMoves: u.moneriumIbanMoves ?? [],
    refusal: u.moneriumRefusal,
    issueOrders: store.moneriumIssueOrders
      .filter((r) => r.userId === u.id)
      .map((r) => ({ ...r, counterpartyIban: maskIdentifier(r.counterpartyIban) }))
      .sort((a, b) => Date.parse(b.processedAt) - Date.parse(a.processedAt)),
    redeemOrders: redeemOrdersOf(u.id),
    audit: moneriumAudit(u.id),
  };
}

type Part = { ok: true; data: unknown } | { ok: false; status?: number; error: string };
async function part(p: () => Promise<unknown>): Promise<Part> {
  try {
    return { ok: true, data: await p() };
  } catch (err) {
    return {
      ok: false,
      status: err instanceof MoneriumApiError ? err.status : undefined,
      error: String((err as Error)?.message ?? err).slice(0, 400),
    };
  }
}

/** Ask Monerium now, on the account's own connection. Nothing is stored. */
export async function liveMonerium(u: User, operator: string) {
  // The stored secret itself, not `method`: moneriumClientFor falls back to
  // the app client when neither is there, and a row can name a method whose
  // token is gone.
  if (!u.monerium?.apiKeys && !u.monerium?.accessTokenEnc) {
    return { available: false as const, reason: "This account has no Monerium connection of its own (OAuth token or API keys), so there is nothing to read as this person." };
  }
  const client = moneriumClientFor(u);
  const profileId = u.monerium?.profileId ?? u.funding?.moneriumProfileId;
  const [context, profiles, profile, ibans, addresses, orders] = await Promise.all([
    part(() => client.authContext()),
    part(() => client.profiles()),
    profileId ? part(() => client.profile(profileId)) : Promise.resolve<Part>({ ok: false, error: "no connected profile id" }),
    part(() => client.ibans()),
    part(() => client.addresses()),
    part(() => client.orders(profileId)),
  ]);
  store.audit(auditEntry("operator.monerium_read", { partner: "monerium", operator, profileId }, u.id));
  return { available: true as const, readAt: new Date().toISOString(), context, profiles, profile, ibans, addresses, orders };
}

/** Deployment-wide Monerium picture: config, accounts, orders, audit. */
export async function moneriumOverview(live: boolean) {
  const accounts = store.users.filter((u) => u.monerium || u.funding?.moneriumProfileId || u.moneriumRefusal).map(moneriumAccountRow);
  const orgAccounts = store.accounts
    .filter((a) => a.moneriumProfile || a.provider === "monerium")
    .map((a) => ({
      accountId: a.id,
      orgId: a.orgId,
      org: store.findOrganisation(a.orgId)?.name,
      label: a.label,
      status: a.status,
      backingUserId: a.backingUserId,
      profile: a.moneriumProfile,
      detail: a.detail,
    }));
  const names = new Map(store.users.map((u) => [u.id, u.name]));
  return {
    deployment: moneriumDeployment(),
    app: live ? await part(() => checkConnection()) : undefined,
    accounts,
    orgAccounts,
    issueOrders: store.moneriumIssueOrders
      .slice()
      .sort((a, b) => Date.parse(b.processedAt) - Date.parse(a.processedAt))
      .slice(0, 300)
      .map((r) => ({ ...r, counterpartyIban: maskIdentifier(r.counterpartyIban), userName: names.get(r.userId) })),
    redeemOrders: redeemOrdersOf().slice(0, 300).map((r) => ({ ...r, userName: names.get(r.userId) })),
    audit: moneriumAudit(undefined, 300).map((e) => ({ ...e, userName: e.userId ? names.get(e.userId) : undefined })),
  };
}
