/**
 * Monerium integration (real API calls; production by default, the sandbox
 * when MONERIUM_BASE_URL points at api.monerium.dev).
 *
 * Activates when MONERIUM_CLIENT_ID/SECRET are set, or per user when they
 * connected their own account (OAuth or API keys). What it does:
 *
 *  1. Activation: link the user's Safe with a signed ownership declaration
 *     under the connected profile and request the IBAN. Issuance can be
 *     async; we poll for it.
 *  2. Deposits: polls Monerium `issue` orders (EURe minted after a SEPA
 *     transfer arrives). The EURe lands in the Safe; nothing is mirrored on a
 *     real chain. The hardhat harness (31337) mints MockToken instead, since
 *     Monerium issues nothing there.
 *
 * Webhooks (order.updated / iban.updated) are the production path; polling is
 * used here because local dev has no public URL.
 */
import { MONERIUM, moneriumSandboxEnabled } from "../config.js";
import { store, type User } from "../store.js";
import { MoneriumApiError, MoneriumClient, type MoneriumOrder } from "./monerium-client.js";
import { moneriumAppClient, moneriumClientFor, usersWithOwnCredentials } from "./monerium-connection.js";
import { HARNESS } from "../config.js";
import { abis, addrs, deployerWallet, eur, writeAndWait } from "../chain.js";
import { keccak256, toHex } from "viem";
import { moneriumAmountString, moneriumRedeemMessage, normalizeIban } from "../sepa.js";
import { attributeMoneriumOrder, attributeMoneriumOrderToInvoice } from "../routes/payment-requests.js";
import { noteMoneriumIssue, writeStatementLines } from "../bookkeeping/writer.js";
import { moneriumOrderProcessed } from "../domain/monerium-order.js";
import { describeCause } from "../http/log-cause.js";

/**
 * The bank facts of a processed issue order on our chain, for the statement
 * line. Runs for every processed order seen, whether or not this poll
 * mirrored it, so orders recorded before the table existed still get lines.
 */
function keepIssueFacts(order: MoneriumOrder): void {
  if (order.kind !== "issue" || !isProcessed(order)) return;
  if (order.chain !== MONERIUM.chain) return;
  if (String(order.currency ?? "eur").toLowerCase() !== "eur") return;
  const user = store.findUserByAddress(order.address);
  if (user) noteMoneriumIssue(order, user);
}

/**
 * The APP's client (MONERIUM_CLIENT_ID/SECRET). Anything about ONE user goes
 * through `moneriumClientFor(user)` instead, which prefers the credentials the
 * user connected themselves — their profile is invisible to the app's keys.
 */
function getClient(): MoneriumClient {
  return moneriumAppClient();
}

/** Auth smoke test — used by scripts/monerium-check.ts and server startup. */
export async function checkConnection() {
  const ctx = await getClient().authContext();
  return ctx;
}



/** Look up the issued IBAN for an address, if any yet — on the user's own
 *  credentials when they have some, since that is where their IBAN lives.
 *  An IBAN that names a profile other than the user's connected one is not
 *  theirs, whatever address it pays. */
export async function findIban(address: string, user?: User): Promise<string | undefined> {
  const res = await (user ? moneriumClientFor(user) : getClient()).ibans();
  const list = Array.isArray(res) ? res : (res?.ibans ?? []);
  const profileId = user ? (user.monerium?.profileId ?? user.funding?.moneriumProfileId) : undefined;
  const hit = list.find(
    (i: any) =>
      String(i.address ?? "").toLowerCase() === address.toLowerCase() &&
      i.iban &&
      !(profileId && typeof i.profile === "string" && i.profile !== profileId),
  );
  return hit?.iban;
}

/** The BIC Monerium lists for this user's IBAN, or undefined when Monerium
 *  lists none for it. Read on the user's own credentials, as findIban is. */
export async function findIbanBic(user: User): Promise<string | undefined> {
  if (!user.iban) return undefined;
  const res = await moneriumClientFor(user).ibans();
  const list = Array.isArray(res) ? res : (res?.ibans ?? []);
  const target = normalizeIban(user.iban);
  const hit = list.find((i: any) => typeof i?.iban === "string" && normalizeIban(i.iban) === target);
  const bic = typeof hit?.bic === "string" ? hit.bic.toUpperCase().replace(/\s+/g, "") : "";
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic) ? bic : undefined;
}

/**
 * Monerium attributes an IBAN to one address. Once it attributes `iban` to
 * `keepUserId`'s Safe (a move), any other account here still holding it is
 * showing an IBAN that no longer pays it: clear it there and say why. The
 * funding goes back to iban_pending, so moving the IBAN back at Monerium
 * re-attributes it through refreshPendingIban.
 */
export function releaseIbanFromOtherUsers(iban: string, keepUserId: string): void {
  const target = normalizeIban(iban);
  for (const other of store.users) {
    if (other.id === keepUserId || !other.iban || normalizeIban(other.iban) !== target) continue;
    store.updateUser(other.id, {
      iban: "",
      funding: {
        ...(other.funding ?? { mode: "sandbox" as const }),
        mode: other.funding?.mode ?? "sandbox",
        status: "iban_pending",
        detail: `IBAN ${target.slice(-4).padStart(8, "•")} was moved at Monerium to another address on ${new Date().toISOString().slice(0, 10)}; it no longer pays into this account`,
      },
    });
  }
}

/**
 * An address-matched IBAN approves an account only from `pending`. A
 * rejected or manual_review account is not approved by an IBAN appearing,
 * and an approved one keeps its original approval record.
 */
export const mayApproveOnIban = (user: User) => user.kycStatus === "pending";

/** Mark the newest unconfirmed move of `iban` on this user as confirmed. */
export function confirmedMoves(user: User, iban: string): User["moneriumIbanMoves"] {
  const moves = user.moneriumIbanMoves;
  if (!moves?.length) return moves;
  const target = normalizeIban(iban);
  const idx = moves.map((m) => !m.confirmedAt && normalizeIban(m.iban) === target).lastIndexOf(true);
  if (idx < 0) return moves;
  return moves.map((m, i) => (i === idx ? { ...m, confirmedAt: new Date().toISOString() } : m));
}

/** Re-check a user whose IBAN was still pending. */
export async function refreshPendingIban(user: User): Promise<User> {
  if (user.funding?.status !== "iban_pending") return user;
  try {
    const iban = await findIban(user.address, user);
    if (iban) {
      // A move (PATCH /ibans) that Monerium has now carried out: record it
      // and take the IBAN off whichever account it used to pay.
      releaseIbanFromOtherUsers(iban, user.id);
      // An address-matched IBAN is what approves an account (activate does the
      // same when the IBAN is there at once). Without this, an IBAN issued
      // after activation was stored but the account stayed pending, and the
      // app hides the IBAN of a pending account.
      // Allowlist, not denylist: only a pending account is approved by its
      // IBAN. manual_review (and anything added later) stays where it is.
      const approve = mayApproveOnIban(user);
      return store.updateUser(user.id, {
        iban,
        funding: { ...user.funding, status: "active", detail: undefined },
        ...(user.moneriumIbanMoves ? { moneriumIbanMoves: confirmedMoves(user, iban) } : {}),
        ...(approve
          ? {
              kycStatus: "approved" as const,
              kyc: {
                provider: "monerium" as const,
                onboardingPath: "existing_monerium" as const,
                checkedAt: new Date().toISOString(),
                applicantId: user.funding.moneriumProfileId,
                reason: `approved when Monerium issued the IBAN for ${user.address}`,
              },
            }
          : {}),
      });
    }
  } catch {
    // transient — keep pending
  }
  return user;
}

export interface SepaCounterpart {
  iban: string;
  firstName: string;
  lastName: string;
  country: string;
}

export interface RedeemAuthorization {
  amount: string;
  iban: string;
  issuedAt: string;
  message: string;
  memo?: string;
  signature: `0x${string}`;
}

/**
 * Place a real redeem order: burn EURe from the user's Safe on the sandbox
 * chain and pay out via SEPA to the counterpart IBAN. The Safe signs the
 * payment message (EIP-1271), exactly like address linking.
 * Requires the Safe to actually hold EURe on the sandbox chain.
 */
export async function redeemToIban(
  user: User,
  amountEur: number,
  counterpart: SepaCounterpart,
  memo?: string,
  authorization?: RedeemAuthorization,
): Promise<MoneriumOrder> {
  const amount = moneriumAmountString(amountEur);
  const iban = normalizeIban(counterpart.iban);
  let message: string;
  let signature: `0x${string}`;
  if (authorization) {
    const expected = moneriumRedeemMessage(amountEur, iban, authorization.issuedAt);
    if (
      authorization.amount !== amount ||
      authorization.iban !== iban ||
      authorization.message !== expected.message ||
      (authorization.memo ?? "") !== (memo ?? "")
    ) {
      throw new Error("Monerium redeem authorization does not match this payout");
    }
    message = authorization.message;
    signature = authorization.signature;
  } else {
    throw new Error("Monerium redeem requires passkey Safe authorization");
  }
  return moneriumClientFor(user).placeOrder({
    address: user.address,
    chain: MONERIUM.chain,
    kind: "redeem",
    amount,
    currency: "eur",
    counterpart: {
      identifier: { standard: "iban", iban },
      details: {
        firstName: counterpart.firstName,
        lastName: counterpart.lastName,
        country: counterpart.country,
      },
    },
    message,
    signature,
    ...(memo ? { memo } : {}),
  });
}

export async function getOrderState(orderId: string, user?: User): Promise<string> {
  const order = await (user ? moneriumClientFor(user) : getClient()).getOrder(orderId);
  return order.meta?.state ?? order.state ?? "unknown";
}

function orderList(res: Awaited<ReturnType<MoneriumClient["orders"]>>): MoneriumOrder[] {
  return Array.isArray(res) ? res : (res?.orders ?? []);
}

function isProcessed(o: MoneriumOrder): boolean {
  return moneriumOrderProcessed(o.meta?.state ?? o.state);
}

/**
 * What happened to a delivery. The distinction that matters is `unavailable`:
 * we could not reach Monerium, or another caller is recording the order right
 * now — either way the order is not settled, so the caller must leave the
 * delivery un-consumed and let the sender retry.
 */
export type MirrorOutcome = "recorded" | "duplicate" | "ignored" | "unavailable";

/**
 * Order ids a caller is recording right now. Between the processed check and
 * `markOrderProcessed` sit awaits (the token lookup, the local mint), so the
 * poller and a webhook — or two webhook deliveries for one order — could both
 * pass the check and both record it. The claim is taken in the same
 * synchronous step as the check, before the first await.
 *
 * A claimed order is not yet recorded, so a second caller gets `unavailable`,
 * not `duplicate`: the claim holder can still fail, and a webhook delivery
 * answered `duplicate` would be spent. The claim lives in this process, which
 * is enough while the store is one process's file.
 */
const recording = new Set<string>();

/**
 * Record one order that came from Monerium's own API. Local/mock chains mint
 * EURe into the user's Safe; real Monerium deposits are already in the Safe.
 *
 * The caller must have fetched `order` from Monerium — never pass in an
 * object built from a request body. Amount and address are taken from the
 * order. A repeat is `duplicate`; a concurrent second caller is
 * `unavailable` and records nothing.
 */
async function mirrorOrder(order: MoneriumOrder): Promise<MirrorOutcome> {
  if (order.kind !== "issue" || !isProcessed(order)) return "ignored";
  // Monerium issues several currencies and links one address on six chains;
  // only an EURe issue on OUR chain is a euro deposit to this account.
  if (order.chain !== MONERIUM.chain) return "ignored";
  if (String(order.currency ?? "eur").toLowerCase() !== "eur") return "ignored";
  if (store.isOrderProcessed(order.id)) return "duplicate";
  if (recording.has(order.id)) return "unavailable";
  const user = store.findUserByAddress(order.address);
  if (!user) return "ignored";
  const amount = Number(order.amount);
  if (!(amount > 0)) return "ignored";
  recording.add(order.id);
  try {
    // Monerium minted the EURe into the user's Safe on the app chain; there is
    // nothing to move and nothing to mint — the Safe balance IS the account.
    const { moneriumEureOrUnavailable, MoneriumTokensUnavailable } = await import("./monerium-tokens.js");
    const { CHAIN_ID } = await import("../config.js");
    let eure;
    try {
      eure = await moneriumEureOrUnavailable(MONERIUM.baseUrl, CHAIN_ID);
    } catch (err: any) {
      if (!(err instanceof MoneriumTokensUnavailable)) throw err;
      console.warn(`monerium: could not read Monerium's tokens for order ${order.id}, will retry: ${describeCause(err)}`);
      return "unavailable";
    }
    if (!eure) {
      if (HARNESS.enabled) {
        // Test fixture, hardhat only: the harnesses' stub Monerium reports an
        // order and the local MockToken stands in for the mint. Unreachable on
        // any real-money chain (HARNESS needs chain 31337).
        await mintLocalTestEure(user.address, amount, `monerium:${order.id}`);
      } else {
        console.warn(`monerium: order ${order.id} is on a chain where Monerium issues no EURe (${CHAIN_ID}); not recorded`);
        return "ignored";
      }
    }
    store.markOrderProcessed(order.id);
    noteMoneriumIssue(order, user);
    console.log(`monerium: recorded issue order ${order.id} (€${amount}) for ${user.name}`);
    return "recorded";
  } finally {
    recording.delete(order.id);
  }
}

async function mintLocalTestEure(to: `0x${string}`, amountEur: number, ref: string) {
  await writeAndWait(deployerWallet, {
    address: addrs().eure,
    abi: abis.MockToken,
    functionName: "mint",
    args: [to, eur.toWei(amountEur)],
  });
  return keccak256(toHex(ref));
}

/**
 * Mirror an order named only by id, re-reading it from Monerium first.
 *
 * This is what makes the webhook safe: a caller can name an order but cannot
 * state its amount, its address, or whether it settled — those come from
 * Monerium over an authenticated client-credentials connection. The worst a
 * forged payload achieves is asking us to re-check a real order, which is
 * idempotent.
 */
export async function mirrorOrderById(orderId: string): Promise<MirrorOutcome> {
  if (store.isOrderProcessed(orderId)) return "duplicate";
  if (recording.has(orderId)) return "unavailable";
  let order: MoneriumOrder;
  try {
    order = await getClient().getOrder(orderId);
  } catch (err: any) {
    // A 404 is Monerium telling us this order does not exist — a settled
    // answer. Anything else (5xx, a timeout, DNS) means we simply could not
    // ask, and the caller must be free to try again rather than treat the
    // delivery as spent.
    const status = err instanceof MoneriumApiError ? err.status : 0;
    if (status >= 400 && status < 500) {
      console.warn(`monerium: refusing unknown order ${orderId}: ${describeCause(err)}`);
      return "ignored";
    }
    console.warn(`monerium: could not read order ${orderId}, will retry: ${describeCause(err)}`);
    return "unavailable";
  }
  if (order.id !== orderId) return "ignored";
  return mirrorOrder(order);
}

/**
 * Every profile a user's account is attributed to, plus the app's default.
 *
 * Monerium scopes /orders to one profile at a time — so "all our orders"
 * means asking once per profile. Derived from our own users rather than from
 * Monerium's profile list, which holds abandoned shells from earlier runs
 * that would be pointless traffic to poll.
 */
function ourProfileIds(): (string | undefined)[] {
  const ids = new Set<string>();
  for (const u of store.users) {
    const id = u.funding?.moneriumProfileId;
    if (id) ids.add(id);
  }
  // `undefined` = the default profile, which is where a deployment without
  // per-user profiles (MONERIUM_PROFILE_ID unset on a non-whitelabel plan)
  // puts everything.
  return [undefined, ...ids];
}

/** Every processed `issue` order across our profiles — the reconciler's view
 *  of what should have been credited locally. */
export async function listProcessedIssueOrders(): Promise<MoneriumOrder[]> {
  const seen = new Map<string, MoneriumOrder>();
  for (const profile of moneriumSandboxEnabled() ? ourProfileIds() : []) {
    let list: MoneriumOrder[] = [];
    try {
      list = orderList(await getClient().orders(profile));
    } catch {
      continue; // a dead profile must not blind us to the others
    }
    for (const o of list) if (o.kind === "issue" && isProcessed(o)) seen.set(o.id, o);
  }
  for (const u of usersWithOwnCredentials()) {
    for (const profile of ownProfilesOf(u)) {
      let list: MoneriumOrder[] = [];
      try {
        list = orderList(await moneriumClientFor(u).orders(profile));
      } catch {
        continue;
      }
      for (const o of list) if (o.kind === "issue" && isProcessed(o)) seen.set(o.id, o);
    }
  }
  return [...seen.values()];
}

/**
 * One poll cycle: record new processed `issue` orders.
 * Returns the number of deposits recorded.
 */
export async function pollDepositsOnce(): Promise<number> {
  let credited = 0;
  // Once per profile. An unscoped call returns ONLY the default profile's
  // orders, so with a profile per user this loop is the difference between
  // seeing every customer deposit and seeing none of them.
  for (const profile of moneriumSandboxEnabled() ? ourProfileIds() : []) {
    let list: MoneriumOrder[] = [];
    try {
      list = orderList(await getClient().orders(profile));
    } catch {
      continue;
    }
    for (const order of list) {
      if ((await mirrorOrder(order)) === "recorded") credited++;
      // A payer who wrote a pay-link code on their transfer: the order's memo
      // carries it. Idempotent, so re-seeing an order records nothing twice.
      attributeMoneriumOrder(order);
      // Or the ordinary case: they wrote the invoice number, because that is
      // what is printed beside the bank details on the sheet.
      attributeMoneriumOrderToInvoice(order);
      keepIssueFacts(order);
    }
  }
  /**
   * Users who connected their OWN Monerium account (API keys or OAuth). Their
   * IBAN sits under a profile the app's credentials cannot see, so their
   * deposits are only visible on their client. mirrorOrder attributes by the
   * order's address, and dedupes on the order id, so an order seen twice
   * (default profile and named profile) is recorded once.
   */
  for (const u of usersWithOwnCredentials()) {
    for (const profile of ownProfilesOf(u)) {
      let list: MoneriumOrder[] = [];
      try {
        list = orderList(await moneriumClientFor(u).orders(profile));
      } catch (err: any) {
        console.warn(`monerium: could not read orders for ${u.id} on their own credentials: ${describeCause(err)}`);
        continue;
      }
      for (const order of list) {
        if ((await mirrorOrder(order)) === "recorded") credited++;
        attributeMoneriumOrder(order);
        attributeMoneriumOrderToInvoice(order);
        keepIssueFacts(order);
      }
    }
  }
  writeStatementLines();
  return credited;
}

/** The profiles a user's own credentials should be asked about: their default
 *  (unscoped) and the one we recorded, when it differs. */
function ownProfilesOf(u: User): (string | undefined)[] {
  const named = u.monerium?.profileId ?? u.funding?.moneriumProfileId;
  return named ? [undefined, named] : [undefined];
}

/**
 * Advance transfers whose SEPA redeem order is still in flight. A transfer in
 * unresolved review keeps its order state current and nothing else: that
 * state is what lets an operator cite the order as paid (review-evidence.ts).
 */
export async function pollRedeemOrdersOnce(): Promise<void> {
  const waiting = store.transfers.filter(
    (t) =>
      (t.state === "PAYOUT_SUBMITTED" || (t.state === "MANUAL_REVIEW" && !t.reviewResolution)) &&
      t.sepa?.mode === "sandbox" &&
      t.sepa.orderId,
  );
  for (const t of waiting) {
    try {
      // The order was placed on this user's client, so it is read on it too.
      const state = await getOrderState(t.sepa!.orderId!, store.findUser(t.userId));
      if (t.state === "MANUAL_REVIEW") {
        if (state !== t.sepa!.state) store.updateTransfer(t.id, { sepa: { ...t.sepa!, state } });
      } else if (moneriumOrderProcessed(state)) {
        store.updateTransfer(t.id, { state: "PAID", sepa: { ...t.sepa!, state } });
        console.log(`monerium: redeem order ${t.sepa!.orderId} processed (transfer ${t.id})`);
        writeStatementLines();
      } else if (state === "rejected" || state === "failed") {
        store.updateTransfer(t.id, {
          state: "FAILED",
          error: `Monerium redeem order ${state}`,
          sepa: { ...t.sepa!, state },
        });
      } else if (state !== t.sepa!.state) {
        store.updateTransfer(t.id, { sepa: { ...t.sepa!, state } });
      }
    } catch {
      // transient — retry next tick
    }
  }
}

export function startDepositPoller() {
  // One tick at a time: a slow partner or RPC must not stack a second pass
  // over the same rows on top of the first.
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await pollDepositsOnce();
      await pollRedeemOrdersOnce();
      for (const u of store.users) {
        if (u.funding?.status === "iban_pending") await refreshPendingIban(u);
      }
    } catch (err: any) {
      console.error(`monerium poll failed: ${describeCause(err)}`);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, MONERIUM.pollMs);
  timer.unref();
  return timer;
}

/**
 * Webhook receiver (production path — needs a public URL).
 *
 * The body is treated as untrusted: we read an order id out of it and throw
 * the rest away, then re-read that order from Monerium. Crediting whatever
 * address and amount the request stated would make this an unauthenticated
 * mint for anyone who could reach the port.
 *
 * A shared secret (MONERIUM_WEBHOOK_SECRET) gates it further when set — see
 * verifyWebhookSignature in server.ts. Both controls are worth having: the
 * secret keeps strangers out, the re-read means even a leaked secret cannot
 * fabricate a deposit.
 */
export async function handleWebhookEvent(
  event: any,
): Promise<{ handled: boolean; outcome: MirrorOutcome }> {
  const id = event?.data?.id ?? event?.order?.id ?? event?.id;
  if (!id || typeof id !== "string") return { handled: false, outcome: "ignored" };
  const outcome = await mirrorOrderById(id);
  return { handled: outcome === "recorded", outcome };
}
