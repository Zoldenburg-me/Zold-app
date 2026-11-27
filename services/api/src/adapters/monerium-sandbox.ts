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
import { store, type Transfer, type User } from "../store.js";
import { isMoneriumOrderId, MoneriumApiError, MoneriumClient, moneriumFailureReason, type MoneriumOrder } from "./monerium-client.js";
import { hasOwnMoneriumCredentials, moneriumAppClient, moneriumClientFor, usersWithOwnCredentials } from "./monerium-connection.js";
import { auditEntry } from "../audit.js";
import { HARNESS } from "../config.js";
import { abis, addrs, deployerWallet, eur, writeAndWait } from "../chain.js";
import { keccak256, toHex } from "viem";
import { moneriumAmountString, moneriumRedeemMessage, normalizeIban } from "../sepa.js";
import { attributeMoneriumOrder, attributeMoneriumOrderToInvoice } from "../routes/payment-requests.js";
import { noteMoneriumIssue, writeStatementLines } from "../bookkeeping/writer.js";
import { bookHolderLabel, moneyInHolder, type MoneyInHolder } from "../bookkeeping/money-in.js";
import { moneriumAmountEur, moneriumOrderProcessed, redeemMemoDiffers, redeemOrderDiffers } from "../domain/monerium-order.js";
import { can } from "../domain/segments.js";
import { orgEntity } from "../domain/org-entity.js";
import { companyEurAccount } from "../domain/org-monerium-iban.js";
import type { Organisation } from "../domain/types.js";
import { companyMoneriumClient, type CompanyMonerium } from "../routes/business/org-monerium-iban.js";

/**
 * The bank facts of a processed issue order on our chain, for the statement
 * line. Runs for every processed order seen, whether or not this poll
 * mirrored it, so orders recorded before the table existed still get lines.
 */
async function keepIssueFacts(order: MoneriumOrder): Promise<void> {
  return store.tx(async () => {
    if (order.kind !== "issue" || !isProcessed(order)) return;
    if (order.chain !== MONERIUM.chain) return;
    if (String(order.currency ?? "eur").toLowerCase() !== "eur") return;
    const holder = await bookableHolder(order);
    if (holder) await noteMoneriumIssue(order, holder);
  });
}

/** Who a deposit is booked to, or undefined. An address naming more than one
 *  holder books nothing and says so once per order: never a guess. */
const unbookableWarned = new Set<string>();
async function bookableHolder(order: MoneriumOrder): Promise<MoneyInHolder | undefined> {
  const r = await moneyInHolder(String(order.address ?? ""));
  if (r.kind === "user" || r.kind === "account") return r;
  if (r.kind === "unbookable" && !unbookableWarned.has(order.id)) {
    unbookableWarned.add(order.id);
    console.warn(`monerium: issue order ${order.id} not booked: ${r.reason}`);
  }
  return undefined;
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
  return ownIbanIn(Array.isArray(res) ? res : (res?.ibans ?? []), address, user);
}

/** The IBAN in `list` that pays into `address` on our chain, on the user's profile. */
function ownIbanIn(list: any[], address: string, user?: User): string | undefined {
  const profileId = user ? (user.monerium?.profileId ?? user.funding?.moneriumProfileId) : undefined;
  const hit = list.find(
    (i: any) =>
      paysInto(i, address) &&
      i.iban &&
      !(profileId && typeof i.profile === "string" && i.profile !== profileId),
  );
  return hit?.iban;
}

/**
 * Does Monerium's IBAN record `i` pay into `address` on our chain? Monerium
 * links one address on several chains, and mirrorOrder records only issues on
 * MONERIUM.chain, so an IBAN pointed at this address on another chain does
 * not fund this account. A record without a chain is taken on the address.
 */
export function paysInto(i: any, address: string): boolean {
  return (
    String(i?.address ?? "").toLowerCase() === address.toLowerCase() &&
    (!i?.chain || i.chain === MONERIUM.chain)
  );
}

const ibanList = (res: any): any[] => (Array.isArray(res) ? res : (res?.ibans ?? []));

/**
 * Compare the IBAN this account stores with Monerium's list of the user's
 * IBANs (`ibans`, read on their own credentials). When Monerium lists it
 * paying into another address or chain, someone moved it at Monerium: take
 * it off this account, say where it went, and keep that for the app to offer
 * moving it back. funding goes to iban_pending, so a move back is picked up
 * by refreshPendingIban.
 *
 * Fails closed: the IBAN missing from the list, or listed more than once, is
 * no verdict and changes nothing. Only an active account with an IBAN is
 * checked.
 */
export async function applyIbanBinding(user0: User, ibans: any[]): Promise<User> {
  return store.tx(async () => {
    // The row as stored, held: the caller's copy was read before Monerium answered.
    const user = (await store.lockUser(user0.id)) ?? user0;
    if (user.funding?.status !== "active" || !user.iban) return user;
    const target = normalizeIban(user.iban);
    const hits = ibans.filter((i: any) => typeof i?.iban === "string" && normalizeIban(i.iban) === target);
    if (hits.length !== 1) return user;
    const hit = hits[0];
    if (!hit.address || paysInto(hit, user.address)) return user;
    const address = String(hit.address);
    const chain = typeof hit.chain === "string" ? hit.chain : "";
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
    const onChain = chain && chain !== MONERIUM.chain ? ` on ${chain}` : "";
    const updated = await store.updateUser(user.id, {
      iban: "",
      funding: {
        ...user.funding,
        status: "iban_pending",
        detail: `IBAN ending ${target.slice(-4)} now pays into another address at Monerium (${short}${onChain}); it no longer pays into this account`,
      },
      moneriumIbanElsewhere: {
        iban: target,
        address,
        chain,
        ...(typeof hit.profile === "string" ? { profileId: hit.profile } : {}),
        seenAt: new Date().toISOString(),
      },
    });
    await store.audit(auditEntry(
      "partner.iban_moved_elsewhere",
      { partner: "monerium", ibanLast4: target.slice(-4), toAddress: address, toChain: chain },
      user.id,
    ));
    console.warn(`monerium: IBAN …${target.slice(-4)} of ${user.id} now pays into ${short} (${chain || "no chain"}); cleared`);
    return updated;
  });
}

/** When each user's IBAN was last re-read by verifyIbanBinding. */
const ibanCheckedAt = new Map<string, number>();

/**
 * Re-read the user's IBANs at Monerium on their own credentials and apply
 * applyIbanBinding. At most once per MONERIUM.ibanCheckMs per user. A read
 * that fails changes nothing.
 */
export async function verifyIbanBinding(user: User): Promise<User> {
  if (user.funding?.status !== "active" || !user.iban || !hasOwnMoneriumCredentials(user)) return user;
  const last = ibanCheckedAt.get(user.id);
  if (last !== undefined && Date.now() - last < MONERIUM.ibanCheckMs) return user;
  ibanCheckedAt.set(user.id, Date.now());
  let ibans: any[];
  try {
    ibans = ibanList(await moneriumClientFor(user).ibans());
  } catch (err: any) {
    console.warn(`monerium: could not re-read the IBAN of ${user.id}: ${moneriumFailureReason(err)}`);
    return user;
  }
  // The read is an await: take the row as it is now.
  return await applyIbanBinding((await store.findUser(user.id)) ?? user, ibans);
}

/** The BIC Monerium lists for this user's IBAN, or undefined when Monerium
 *  lists none for it. Read on the user's own credentials, as findIban is. */
export async function findIbanBic(user: User): Promise<string | undefined> {
  if (!user.iban) return undefined;
  const list = ibanList(await moneriumClientFor(user).ibans());
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
export async function releaseIbanFromOtherUsers(iban: string, keepUserId: string): Promise<void> {
  return store.tx(async () => {
    const target = normalizeIban(iban);
    for (const listed of (await store.list("users"))) {
      if (listed.id === keepUserId || !listed.iban || normalizeIban(listed.iban) !== target) continue;
      // Read again, held: the list is a snapshot.
      const other = await store.lockUser(listed.id);
      if (!other?.iban || normalizeIban(other.iban) !== target) continue;
      await store.updateUser(other.id, {
        iban: "",
        funding: {
          ...(other.funding ?? { mode: "sandbox" as const }),
          mode: other.funding?.mode ?? "sandbox",
          status: "iban_pending",
          detail: `IBAN ${target.slice(-4).padStart(8, "•")} was moved at Monerium to another address on ${new Date().toISOString().slice(0, 10)}; it no longer pays into this account`,
        },
      });
    }
  });
}

/**
 * An address-matched IBAN approves an account only from `pending`. A
 * rejected or manual_review account is not approved by an IBAN appearing,
 * and an approved one keeps its original approval record.
 */
export const mayApproveOnIban = (user: User) => user.kycStatus === "pending";

/**
 * Why Zold must not link a Safe to Monerium or ask for an IBAN for this
 * account, else undefined: its segment has no bank account (the app's
 * `bankOffered()`), Monerium refused or is still reviewing it, or a pending
 * account has no Monerium connection of its own. Checked before any Monerium
 * call or passkey ceremony; the app hiding the button is not the check.
 */
export function ibanActivationRefusal(user: User): { error: string; code: string } | undefined {
  if (!can(user.segment?.value ?? "EU_FULL", "monerium")) {
    return { error: "a bank account is not part of your account", code: "IBAN_NOT_OFFERED" };
  }
  if (user.kycStatus === "approved") return undefined;
  if (user.kycStatus === "manual_review") {
    return { error: "Monerium is still reviewing this account, so there is no IBAN yet", code: "IBAN_NOT_OFFERED" };
  }
  if (user.kycStatus !== "pending") {
    return { error: "we can’t open a bank account for this account", code: "IBAN_NOT_OFFERED" };
  }
  if (!hasOwnMoneriumCredentials(user)) {
    return {
      error: "connect a Monerium account first — sign in with Monerium or add your Monerium API keys — before activating an IBAN",
      code: "MONERIUM_NOT_CONNECTED",
    };
  }
  return undefined;
}

/**
 * The funding of an account Zold may not bank (`ibanActivationRefusal` says
 * IBAN_NOT_OFFERED): no IBAN is coming, and the refusal says why. One shape
 * for the OAuth callback, the API-key connect and the poller. Named fields
 * only: the mode, and the address verdict, which stays true of the address.
 * Nothing tied to an IBAN carries over.
 */
export function refusedFunding(user: User, moneriumProfileId: string | undefined, detail: string): NonNullable<User["funding"]> {
  return {
    mode: user.funding?.mode ?? "sandbox",
    status: "kyc_pending",
    ...(moneriumProfileId ? { moneriumProfileId } : {}),
    detail,
    ...(user.funding?.addressUnlinkable ? { addressUnlinkable: true } : {}),
  };
}

/** Mark the newest unconfirmed move of `iban` on this user as confirmed. */
export function confirmedMoves(user: User, iban: string): User["moneriumIbanMoves"] {
  const moves = user.moneriumIbanMoves;
  if (!moves?.length) return moves;
  const target = normalizeIban(iban);
  const idx = moves.map((m) => !m.confirmedAt && normalizeIban(m.iban) === target).lastIndexOf(true);
  if (idx < 0) return moves;
  return moves.map((m, i) => (i === idx ? { ...m, confirmedAt: new Date().toISOString() } : m));
}

/**
 * Where an approved, pending account's IBAN pays now, when Monerium lists it
 * paying another address or chain. The IBAN looked for is the one the user
 * last asked to move here, else the one already recorded as elsewhere, else
 * the connected profile's only IBAN (a Monerium profile has one). Listed more
 * than once, or not at all, is no verdict. A pending account that was never
 * approved is activation's business, not this notice's.
 */
export function pendingIbanElsewhere(user: User, ibans: any[]): User["moneriumIbanElsewhere"] | undefined {
  if (user.kycStatus !== "approved" || user.iban) return undefined;
  const profileId = user.monerium?.profileId ?? user.funding?.moneriumProfileId;
  const onProfile = ibans.filter((i: any) =>
    typeof i?.iban === "string" && !(profileId && typeof i.profile === "string" && i.profile !== profileId));
  const asked = [...(user.moneriumIbanMoves ?? [])].reverse().find((m) => !m.confirmedAt)?.iban;
  const only = new Set(onProfile.map((i: any) => normalizeIban(i.iban)));
  const wanted = asked ?? user.moneriumIbanElsewhere?.iban ?? (only.size === 1 ? [...only][0] : undefined);
  if (!wanted) return undefined;
  const target = normalizeIban(wanted);
  const hits = onProfile.filter((i: any) => normalizeIban(i.iban) === target);
  if (hits.length !== 1 || !hits[0].address || paysInto(hits[0], user.address)) return undefined;
  const hit = hits[0];
  return {
    iban: target,
    address: String(hit.address),
    chain: typeof hit.chain === "string" ? hit.chain : "",
    ...(typeof hit.profile === "string" ? { profileId: hit.profile } : {}),
    seenAt: new Date().toISOString(),
  };
}

/** Re-check a user whose IBAN was still pending. For an account Zold may not
 *  bank the poller does not finish an activation the routes refuse: the
 *  account stops waiting on an IBAN and says why. */
export async function refreshPendingIban(user: User): Promise<User> {
  if (user.funding?.status !== "iban_pending") return user;
  const refused = ibanActivationRefusal(user);
  if (refused?.code === "IBAN_NOT_OFFERED") {
    return await store.updateUser(user.id, { funding: refusedFunding(user, user.funding.moneriumProfileId, refused.error) });
  }
  try {
    const list = ibanList(await moneriumClientFor(user).ibans());
    const iban = ownIbanIn(list, user.address, user);
    if (!iban) {
      // Not here: say where it is, so the app offers moving it back. Written
      // only when the place changed, so the poller does not rewrite the row.
      const away = pendingIbanElsewhere(user, list);
      const was = user.moneriumIbanElsewhere;
      if (away && (was?.iban !== away.iban || was?.address.toLowerCase() !== away.address.toLowerCase() || was?.chain !== away.chain)) {
        await store.audit(auditEntry(
          "partner.iban_moved_elsewhere",
          { partner: "monerium", ibanLast4: away.iban.slice(-4), toAddress: away.address, toChain: away.chain },
          user.id,
        ));
        return await store.updateUser(user.id, { moneriumIbanElsewhere: away });
      }
      return user;
    }
    if (iban) {
      // An address-matched IBAN is what approves an account (activate does the
      // same when the IBAN is there at once). Without this, an IBAN issued
      // after activation was stored but the account stayed pending, and the
      // app hides the IBAN of a pending account.
      // Allowlist, not denylist: only a pending account is approved by its
      // IBAN. manual_review (and anything added later) stays where it is.
      return await store.tx(async () => {
        // The row as stored, held: the caller's copy was read before Monerium
        // answered, and KYC may have moved (manual_review, rejected) since.
        const fresh = (await store.lockUser(user.id)) ?? user;
        if (fresh.funding?.status !== "iban_pending") return fresh;
        // A move (PATCH /ibans) that Monerium has now carried out: record it
        // and take the IBAN off whichever account it used to pay. Inside the
        // hold, so a row that stopped waiting releases nobody's IBAN.
        await releaseIbanFromOtherUsers(iban, user.id);
        const approve = mayApproveOnIban(fresh);
        return await store.updateUser(fresh.id, {
          iban,
          funding: { ...fresh.funding, status: "active", detail: undefined },
          moneriumIbanElsewhere: undefined,
          ...(fresh.moneriumIbanMoves ? { moneriumIbanMoves: confirmedMoves(fresh, iban) } : {}),
          ...(approve
            ? {
                kycStatus: "approved" as const,
                kyc: {
                  provider: "monerium" as const,
                  onboardingPath: "existing_monerium" as const,
                  checkedAt: new Date().toISOString(),
                  applicantId: fresh.funding.moneriumProfileId,
                  reason: `approved when Monerium issued the IBAN for ${fresh.address}`,
                },
              }
            : {}),
        });
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
      // The executor passes both from the stored record; kept for any caller that does not.
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

/** An order as Monerium reports it, read on the client that can see this
 *  user's orders (the one a redeem was placed on). */
export function readOrder(orderId: string, user?: User): Promise<MoneriumOrder> {
  return (user ? moneriumClientFor(user) : getClient()).getOrder(orderId);
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
  if (await store.isOrderProcessed(order.id)) return "duplicate";
  // Claimed before the next await: two deliveries of one order must not both
  // get past here.
  if (recording.has(order.id)) return "unavailable";
  recording.add(order.id);
  try {
    // A recording that finished while this one waited above has marked it.
    if (await store.isOrderProcessed(order.id)) return "duplicate";
    const holder = await bookableHolder(order);
    if (!holder) return "ignored";
    const amount = moneriumAmountEur(order.amount);
    if (!amount) return "ignored";
    // Monerium minted the EURe into the user's Safe on the app chain; there is
    // nothing to move and nothing to mint — the Safe balance IS the account.
    const { moneriumEureOrUnavailable, MoneriumTokensUnavailable } = await import("./monerium-tokens.js");
    const { CHAIN_ID } = await import("../config.js");
    let eure;
    try {
      eure = await moneriumEureOrUnavailable(MONERIUM.baseUrl, CHAIN_ID);
    } catch (err: any) {
      if (!(err instanceof MoneriumTokensUnavailable)) throw err;
      console.warn(`monerium: could not read Monerium's tokens for order ${order.id}, will retry: ${moneriumFailureReason(err)}`);
      return "unavailable";
    }
    if (!eure) {
      if (HARNESS.enabled) {
        // Test fixture, hardhat only: the harnesses' stub Monerium reports an
        // order and the local MockToken stands in for the mint. Unreachable on
        // any real-money chain (HARNESS needs chain 31337).
        await mintLocalTestEure(holder.kind === "user" ? holder.user.address : holder.account.address!, amount, `monerium:${order.id}`);
      } else {
        console.warn(`monerium: order ${order.id} is on a chain where Monerium issues no EURe (${CHAIN_ID}); not recorded`);
        return "ignored";
      }
    }
    // The claim and the issue record are one transaction: the order id's key
    // refuses a second recording whatever reached here (a second process, or
    // a caller that got past `recording`), and a crash keeps both or neither.
    const recorded = await store.tx(async () => {
      if (!(await store.markOrderProcessed(order.id))) return false;
      await noteMoneriumIssue(order, holder);
      return true;
    });
    if (!recorded) return "duplicate";
    console.log(`monerium: recorded issue order ${order.id} (€${amount}) for ${bookHolderLabel(holder)}`);
    return "recorded";
  } finally {
    recording.delete(order.id);
  }
}

async function mintLocalTestEure(to: `0x${string}`, amountEur: number, ref: string) {
  if (!deployerWallet) throw new Error("the harness mint needs the local chain's deployer");
  await writeAndWait(deployerWallet, {
    address: addrs().eure,
    abi: abis.MockToken,
    functionName: "mint",
    args: [to, eur.toWei(amountEur)],
  });
  return keccak256(toHex(ref));
}

/** Order reads by id that have not answered: a second delivery of one id
 *  waits for the first read instead of asking Monerium again. */
const reading = new Map<string, Promise<MirrorOutcome>>();
/** Ids Monerium answered 404 for, and until when that answer stands, oldest
 *  first: an id anyone can name costs one read per window, not one per
 *  delivery, and the memory of them is capped. */
const unknownOrders = new Map<string, number>();
const UNKNOWN_ORDER_MS = 10 * 60_000;
const UNKNOWN_ORDERS_MAX = 1000;
/** Order reads in flight at once. Past it a delivery is `unavailable` (503,
 *  which Monerium retries), so a flood of made-up ids cannot fill the read
 *  queue the poller shares (monerium-limit.ts). */
const READS_MAX = 16;

/**
 * Mirror an order named only by id, re-reading it from Monerium first.
 *
 * This is what makes the webhook safe: a caller can name an order but cannot
 * state its amount, its address, or whether it settled — those come from
 * Monerium over an authenticated client-credentials connection. The worst a
 * forged payload achieves is asking us to re-check a real order, which is
 * idempotent, or one read of an id Monerium does not know.
 */
export async function mirrorOrderById(orderId: string): Promise<MirrorOutcome> {
  if (await store.isOrderProcessed(orderId)) return "duplicate";
  // From here to reading.set nothing awaits: a second delivery of one id
  // finds the first one's read in flight.
  if (recording.has(orderId)) return "unavailable";
  if (!isMoneriumOrderId(orderId)) return "ignored";
  const unknownUntil = unknownOrders.get(orderId);
  if (unknownUntil !== undefined && Date.now() < unknownUntil) return "ignored";
  unknownOrders.delete(orderId);
  const inFlight = reading.get(orderId);
  if (inFlight) return await inFlight.then((o) => (o === "recorded" ? "duplicate" : o));
  if (reading.size >= READS_MAX) return "unavailable";
  const read = readAndMirror(orderId).finally(() => reading.delete(orderId));
  reading.set(orderId, read);
  return await read;
}

async function readAndMirror(orderId: string): Promise<MirrorOutcome> {
  let order: MoneriumOrder;
  try {
    order = await getClient().getOrder(orderId);
  } catch (err: any) {
    // Only a 404 is Monerium saying this order does not exist — a settled
    // answer that spends the delivery. Any other refusal (400, 401/403 on our
    // credentials, a 429), a 5xx, a timeout or DNS means the lookup itself
    // failed, and the caller must be free to try the same delivery again.
    // The status alone is logged, for the order read and the token request
    // alike: a refusal's body is Monerium's, not ours.
    const status = err instanceof MoneriumApiError ? err.status : 0;
    const reason = moneriumFailureReason(err);
    if (status === 404) {
      console.warn(`monerium: refusing unknown order ${orderId}: ${reason}`);
      unknownOrders.set(orderId, Date.now() + UNKNOWN_ORDER_MS);
      if (unknownOrders.size > UNKNOWN_ORDERS_MAX) unknownOrders.delete(unknownOrders.keys().next().value!);
      return "ignored";
    }
    console.warn(`monerium: could not read order ${orderId}, will retry: ${reason}`);
    return "unavailable";
  }
  // An answer that is not this order (an empty body, another id) is no
  // answer from Monerium about it: the delivery stays unresolved.
  if (order?.id !== orderId) {
    console.warn(`monerium: the read of order ${orderId} answered another order or none, will retry`);
    return "unavailable";
  }
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
async function ourProfileIds(): Promise<(string | undefined)[]> {
  const ids = new Set<string>();
  for (const u of (await store.list("users"))) {
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
  for (const profile of moneriumSandboxEnabled() ? (await ourProfileIds()) : []) {
    let list: MoneriumOrder[] = [];
    try {
      list = orderList(await getClient().orders(profile));
    } catch {
      continue; // a dead profile must not blind us to the others
    }
    for (const o of list) if (o.kind === "issue" && isProcessed(o)) seen.set(o.id, o);
  }
  for (const u of (await usersWithOwnCredentials())) {
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
  for (const o of (await companyIssueOrders())) if (o.kind === "issue" && isProcessed(o)) seen.set(o.id, o);
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
  for (const profile of moneriumSandboxEnabled() ? (await ourProfileIds()) : []) {
    let list: MoneriumOrder[] = [];
    try {
      list = orderList(await getClient().orders(profile));
    } catch {
      continue;
    }
    for (const order of list) {
      if ((await mirrorOrder(order)) === "recorded") credited++;
      // An amount the mirror refuses (not a euro decimal) settles nothing.
      if (moneriumAmountEur(order.amount) === undefined) continue;
      // A payer who wrote a pay-link code on their transfer: the order's memo
      // carries it. Idempotent, so re-seeing an order records nothing twice.
      await attributeMoneriumOrder(order);
      // Or the ordinary case: they wrote the invoice number, because that is
      // what is printed beside the bank details on the sheet.
      await attributeMoneriumOrderToInvoice(order);
      await keepIssueFacts(order);
    }
  }
  /**
   * Users who connected their OWN Monerium account (API keys or OAuth). Their
   * IBAN sits under a profile the app's credentials cannot see, so their
   * deposits are only visible on their client. mirrorOrder attributes by the
   * order's address, and dedupes on the order id, so an order seen twice
   * (default profile and named profile) is recorded once.
   */
  for (const u of (await usersWithOwnCredentials())) {
    for (const profile of ownProfilesOf(u)) {
      let list: MoneriumOrder[] = [];
      try {
        list = orderList(await moneriumClientFor(u).orders(profile));
      } catch (err: any) {
        console.warn(`monerium: could not read orders for ${u.id} on their own credentials: ${moneriumFailureReason(err)}`);
        continue;
      }
      for (const order of list) {
        if ((await mirrorOrder(order)) === "recorded") credited++;
        if (moneriumAmountEur(order.amount) === undefined) continue;
        await attributeMoneriumOrder(order);
        await attributeMoneriumOrderToInvoice(order);
        await keepIssueFacts(order);
      }
    }
  }
  // A company's own keys (routes/business/org-monerium.ts): its IBAN sits
  // under its own profile, which neither the app's keys nor a member's see.
  for (const order of (await companyIssueOrders())) {
    if ((await mirrorOrder(order)) === "recorded") credited++;
    if (moneriumAmountEur(order.amount) === undefined) continue;
    await attributeMoneriumOrder(order);
    await attributeMoneriumOrderToInvoice(order);
    await keepIssueFacts(order);
  }
  await writeStatementLines();
  return credited;
}

/**
 * Orders on each company's own Monerium keys, for its own Safe only. Those
 * keys are the company's to choose, so an order they list for any other
 * address is not taken as the company's: mirrorOrder books by address, and
 * this keeps a company's keys from feeding orders for someone else's Safe.
 * A company whose keys fail is skipped; the others are still read.
 */
export async function companyIssueOrders(client: (org: Organisation) => Pick<CompanyMonerium, "orders"> = companyMoneriumClient): Promise<MoneriumOrder[]> {
  const out: MoneriumOrder[] = [];
  for (const org of (await store.list("organisations"))) {
    if (!org.monerium || orgEntity(org) !== "company") continue;
    const safe = companyEurAccount(await store.accountsOf(org.id))?.address?.toLowerCase();
    if (!safe) continue;
    let list: MoneriumOrder[];
    try {
      list = orderList((await client(org).orders(org.monerium.profile.id)) as Awaited<ReturnType<MoneriumClient["orders"]>>);
    } catch (err: any) {
      console.warn(`monerium: could not read orders for org ${org.id} on its own keys: ${moneriumFailureReason(err)}`);
      continue;
    }
    for (const o of list) if (String(o.address ?? "").toLowerCase() === safe) out.push(o);
  }
  return out;
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
 *
 * The order read must be the redeem this transfer signed: an answer naming
 * another order (or none) is no read, and a processed or rejected one whose
 * amount, IBAN, kind, currency or Safe differs goes to review, never PAID or
 * FAILED.
 */
/** The stored order state of a redeem that is not the one the transfer
 *  signed. Not `processed`, so payoutEvidence refuses the order. */
const REDEEM_MISMATCH = "mismatch";

/** Why a processed, rejected or failed `order` is not the redeem `t` signed:
 *  the fields redeemOrderDiffers checks, plus chain and memo, as an operator's
 *  attach-redeem-order requires. */
function terminalRedeemMismatch(t: Transfer, order: MoneriumOrder, user: User | undefined): string | undefined {
  if (!t.moneriumRedeem) return "no signed redeem";
  const differs = redeemOrderDiffers(order, t.moneriumRedeem, user?.address ?? "");
  if (differs) return differs;
  if (order.chain !== MONERIUM.chain) return "chain";
  return redeemMemoDiffers(order, t.moneriumRedeem.memo);
}

export async function pollRedeemOrdersOnce(): Promise<void> {
  const waiting = (await store.list("transfers")).filter(
    (t) =>
      (t.state === "PAYOUT_SUBMITTED" || (t.state === "MANUAL_REVIEW" && !t.reviewResolution)) &&
      t.sepa?.mode === "sandbox" &&
      t.sepa.orderId,
  );
  for (const t of waiting) {
    try {
      // The order was placed on this user's client, so it is read on it too.
      const user = await store.findUser(t.userId);
      const order = await readOrder(t.sepa!.orderId!, user);
      if (order?.id !== t.sepa!.orderId) {
        console.warn(`monerium: the read of redeem order ${t.sepa!.orderId} answered another order or none (transfer ${t.id})`);
        continue;
      }
      const state = order.meta?.state ?? order.state ?? "unknown";
      // Decided and written under the transfer's lock, on the row as it is
      // now: another pass may have settled it while this read was in flight,
      // and two pollers must not both write PAID.
      const paid = await store.tx(async () => {
        await store.lockKey(`transfer:${t.id}`);
        const cur = await store.findTransfer(t.id);
        if (!cur || cur.sepa?.orderId !== t.sepa!.orderId) return false;
        if (cur.state !== "PAYOUT_SUBMITTED" && !(cur.state === "MANUAL_REVIEW" && !cur.reviewResolution)) return false;
        // PAID and FAILED are decided on an order that is the signed redeem.
        if (moneriumOrderProcessed(state) || state === "rejected" || state === "failed") {
          const differs = terminalRedeemMismatch(cur, order, user);
          if (differs) {
            // The stored state can already read processed (Monerium's first
            // answer): overwrite it, so review evidence cannot cite this order.
            if (cur.state !== "MANUAL_REVIEW" || cur.sepa!.state !== REDEEM_MISMATCH) {
              await store.patchTransferSub(
                cur.id,
                "sepa",
                (sepa) => ({ ...sepa!, state: REDEEM_MISMATCH, detail: `the order does not match the signed redeem (${differs})` }),
                cur.state === "MANUAL_REVIEW"
                  ? {}
                  : { state: "MANUAL_REVIEW", error: `Monerium's redeem order does not match this transfer (${differs}); not marked paid or failed` },
              );
            }
            return false;
          }
        }
        if (cur.state === "MANUAL_REVIEW") {
          if (state !== cur.sepa!.state) await store.patchTransferSub(cur.id, "sepa", (sepa) => ({ ...sepa!, state }));
        } else if (moneriumOrderProcessed(state)) {
          await store.patchTransferSub(cur.id, "sepa", (sepa) => ({ ...sepa!, state }), { state: "PAID" });
          console.log(`monerium: redeem order ${cur.sepa!.orderId} processed (transfer ${cur.id})`);
          return true;
        } else if (state === "rejected" || state === "failed") {
          await store.patchTransferSub(cur.id, "sepa", (sepa) => ({ ...sepa!, state }), {
            state: "FAILED",
            error: `Monerium redeem order ${state}`,
          });
        } else if (state !== cur.sepa!.state) {
          await store.patchTransferSub(cur.id, "sepa", (sepa) => ({ ...sepa!, state }));
        }
        return false;
      });
      if (paid) await writeStatementLines();
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
      for (const u of (await store.list("users"))) {
        if (u.funding?.status === "iban_pending") await refreshPendingIban(u);
        else if (u.funding?.status === "active" && u.iban) await verifyIbanBinding(u);
      }
    } catch (err: any) {
      console.error(`monerium poll failed: ${moneriumFailureReason(err)}`);
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
