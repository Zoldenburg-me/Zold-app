/**
 * Crypto sends: EURe or USDC from the user's passkey Safe to an address given
 * as an ENS name or a 0x address. No quote, no swap and no Zold fee; gas is
 * paid as SAFE_GAS_PAYMENT says, as for any Safe operation.
 *
 *   POST /users/:id/crypto-sends          resolve, check, hold the cap, prepare
 *   POST /crypto-sends/:id/authorize      re-resolve, verify the passkey, submit
 *
 * The client shows the resolved address and sends it back as
 * `confirmedAddress`; a name that now resolves elsewhere is refused at both
 * steps (ADDRESS_CHANGED). The passkey signs a UserOperation that moves
 * exactly this token and amount to exactly that address, so the chain enforces
 * the destination whatever happens on the server afterwards.
 *
 * A wallet feature, so its gate is the segment and the Safe, never kycStatus
 * (docs/wallet-tier.md). The address is screened at both steps; no answer from
 * the screen, no send.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { CHAIN_ID, cryptoSendEnabled, ENS_GATEWAY, FX, SECURITY } from "../config.js";
import { addrs, publicClient } from "../chain.js";
import { eurPer } from "../rates.js";
import { testUsdc, usdToken } from "../usd-token.js";
import { safeDebitBlocker, safeFundedEurToday } from "../orchestrator.js";
import { store, type CryptoSend, type PendingSafeOp, type User } from "../store.js";
import { requireCapability } from "../http/guards.js";
import { redactedMessage, describeCause } from "../http/log-cause.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import {
  prepareTransferExecution,
  SafeOperationUncertainError,
  SafeVerifierMissingError,
  submitPasskeySafeOperationWithReceipt,
  transferExecutionTransactions,
  userOperationOutcome,
  type PreparedSafeOperation,
} from "../wallet/candide.js";
import { isCompanySafe, type OrgSafeReader } from "../wallet/org-signers.js";
import { SafeOpRefusal, assertQueueOpen, queueSafeOp } from "../wallet/org-safe-queue.js";
import { OrgDebitRefusal, liveCryptoSend, orgDebitSource, orgSafeCapKey, orgSafeSpentEurToday, prepareOrgDebit, type OrgDebitPrepare } from "../wallet/org-debit.js";
import type { Account, Member, OrgSafePlan, Organisation } from "../domain/types.js";
import { b64urlToBuf, verifyAssertionForChallenge } from "../webauthn.js";
import { isSanctioned } from "../sanctions.js";
import { resolveEnsName, type EnsResolution } from "./ens.js";
import { contactsById } from "./business/state.js";
import { findDriftedLines } from "../domain/drafts.js";
import { roleCan } from "../domain/roles.js";
import { orgEntity } from "../domain/org-entity.js";
import { can } from "../domain/plans.js";
import { accountIsSpendable } from "../domain/accounts.js";
import { wrap } from "./util.js";

/** How long the passkey prompt may wait, as for a transfer's terms. */
const AUTH_WINDOW_SEC = 10 * 60;

const SANCTIONED_ERROR = "this address is on a sanctions list, so Zold can’t send to it — nothing was sent";
const SCREENING_DOWN_ERROR = "this address could not be screened just now — nothing was sent; try again";

const ERC20_BALANCE = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface CryptoSendDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => Promise<unknown>;
  /** Tests stub these three; production reads ENS, the chain and rates.ts. */
  resolveName?: (name: string) => Promise<EnsResolution>;
  balanceOf?: (token: `0x${string}`, holder: `0x${string}`) => Promise<bigint>;
  usdPerEur?: () => Promise<number>;
  prepare?: typeof prepareTransferExecution;
  screen?: (address: `0x${string}`) => Promise<boolean>;
  testUsdcAddress?: () => `0x${string}` | undefined;
  /** The tokens a send may move; by default deployments.json's EURe and USDC. */
  sendTokens?: () => Partial<Record<CryptoSend["token"], SendToken>>;
  /** A company send: the org Safe's owners and threshold, and its prepare. */
  orgSafeReader?: OrgSafeReader;
  prepareOrg?: OrgDebitPrepare;
}

type SendToken = { address: `0x${string}`; decimals: number; label: string };
const tokens = (test: `0x${string}` | undefined): Partial<Record<CryptoSend["token"], SendToken>> => ({
  EURE: { address: addrs().eure, decimals: 18, label: "EURe" },
  USDC: { address: usdToken().address, decimals: 6, label: usdToken().symbol },
  ...(test ? { USDC_TEST: { address: test, decimals: 6, label: "testnet USDC" } } : {}),
});

/** A 0x address as given (checksum enforced when mixed case), or an ENS name. */
async function recipient(
  to: string,
  resolveName: (name: string) => Promise<EnsResolution>,
): Promise<{ ok: true; name?: string; address: `0x${string}` } | { ok: false; status: number; code: string; error: string }> {
  if (/^0x[0-9a-fA-F]{40}$/.test(to)) {
    if (!isAddress(to, { strict: true })) {
      return { ok: false, status: 400, code: "BAD_ADDRESS", error: "that address has a wrong checksum — copy it again" };
    }
    return { ok: true, address: getAddress(to) };
  }
  // A name may start with 0x (0xsplits.eth); a dotless 0x string is a mistyped address.
  if (/^0x/i.test(to) && !to.includes(".")) return { ok: false, status: 400, code: "BAD_ADDRESS", error: "an address is 0x and 40 hex characters" };
  const r = await resolveName(to);
  return r.ok ? { ok: true, name: r.name, address: r.address } : r;
}

/**
 * The tokens a Zold payment page's address takes, when `address` is one: a
 * page's Candide forwarder moves only the tokens its routes name, on the
 * chains they name, while its activation lasts; anything else sent there is
 * stranded. Undefined: not a page forwarder. Empty: it takes nothing now.
 * Judged as livePaymentPage judges a page: a list never read from the
 * forwarder's routes, an inactive or expired activation, or a list with no
 * route on this chain takes nothing. A name under our ENS parent that
 * resolves to no known Safe is a page we cannot check, so it takes nothing.
 */
export async function pageAddressTakes(address: `0x${string}`, name?: string, now = Date.now()): Promise<`0x${string}`[] | undefined> {
  const a = address.toLowerCase();
  const isSafeOf = (u: User) => [u.address, u.passkeySafe?.address].some((x) => x?.toLowerCase() === a);
  const owner = (await store.list("users")).find((u) => u.paymentPage?.depositAddress?.toLowerCase() === a);
  if (owner) {
    // A page without forwarding uses the Safe itself, which takes anything.
    if (isSafeOf(owner)) return undefined;
    const page = owner.paymentPage!;
    const f = page.forwarder;
    const live = f?.provider !== "candide" || (f.active && (!f.expiresAt || Date.parse(f.expiresAt) > now) && !!page.routesReadAt);
    if (!live) return [];
    return (page.supportedTokens ?? []).filter((t) => t.chainId === CHAIN_ID).map((t) => t.address);
  }
  const ours = ENS_GATEWAY.enabled && !!name && name.endsWith(`.${ENS_GATEWAY.parent}`);
  if (ours && !(await store.list("users")).some(isSafeOf)) return [];
  return undefined;
}

export async function publicSend(s: CryptoSend) {
  const { userId: _u, ...rest } = await liveCryptoSend(s);
  return rest;
}

/**
 * Settle sends the bundler took but whose receipt never came back. A hash with
 * no receipt stays SUBMITTED: only the chain's answer moves it, so an operation
 * that was dropped keeps showing as being checked.
 */
export async function settleUnconfirmedCryptoSends(outcome = userOperationOutcome) {
  for (const s of (await store.list("cryptoSends"))) {
    // A company send is the op's until the op is MANUAL_REVIEW, which it never
    // leaves: then the receipt for the op's hash is written onto the send.
    const companyHash = s.safeOpId && (await store.findSafeOp(s.safeOpId))?.state === "MANUAL_REVIEW" && (await liveCryptoSend(s)).state === "SUBMITTED"
      ? (await store.findSafeOp(s.safeOpId))?.userOpHash : undefined;
    const hash = s.safeOpId ? companyHash : s.state === "SUBMITTED" ? s.userOpHash : undefined;
    if (!hash) continue;
    try {
      const op = await outcome(hash);
      if (!op) continue;
      await store.updateCryptoSend(s.id, op.success
        ? { state: "SENT", txHash: op.txHash, error: undefined }
        : { state: "FAILED", txHash: op.txHash, error: `included but reverted — nothing left ${s.safeOpId ? "the company's" : "your"} Safe except gas` });
    } catch (err) {
      console.error(`crypto send ${s.id}: receipt read failed: ${describeCause(err)}`);
    }
  }
}

export type CryptoSendInput = { token: unknown; amount: unknown; to: unknown; confirmedAddress: unknown; draftId?: string };
type Refused = { ok: false; status: number; body: { error: string; code?: string; [k: string]: unknown } };
export type PreparedCryptoSend =
  | { ok: true; send: CryptoSend; safeExecution: { credentialId: string; challenge: string } }
  | Refused;
export type PreparedCompanyCryptoSend = { ok: true; send: CryptoSend; op: PendingSafeOp } | Refused;
const refuse = (status: number, body: { error: string; code?: string; [k: string]: unknown }): Refused => ({ ok: false, status, body });

/** The Safe a send leaves from and the daily budget it counts against. */
interface SendPayer {
  safeAddress: `0x${string}`;
  /** Addresses that are this payer's own: a send to one is refused. */
  own: string[];
  capKey: string;
  spentToday: () => Promise<number>;
  /** For logs only. */
  logId: string;
}

type CheckedSend = { ok: true; token: SendToken; symbol: CryptoSend["token"]; units: bigint; to: { name?: string; address: `0x${string}` }; capEur: number; balance: bigint; holdId: string };

type PreparerDeps = Omit<CryptoSendDeps, "requireUserSession">;

/**
 * Every check a crypto send passes before anyone signs it, ending with the
 * daily cap held: token, amount, recipient (ENS, the confirmed address, own
 * and burn addresses, sanctions, a Zold page's tokens), the balance at the
 * payer's Safe. The personal and the company preparer both call this, so
 * neither has a copy of the checks.
 */
async function checkSend(payer: SendPayer, input: CryptoSendInput, deps: Required<Pick<PreparerDeps, "resolveName" | "balanceOf" | "usdPerEur" | "screen" | "sendTokens">>): Promise<CheckedSend | Refused> {
  const sendable = deps.sendTokens();
  const symbol = String(input.token ?? "").toUpperCase() as CryptoSend["token"];
  const token = Object.hasOwn(sendable, symbol) ? sendable[symbol] : undefined;
  if (!token) return refuse(400, { error: "token must be EURE or USDC", code: "BAD_TOKEN" });
  const amountText = String(input.amount ?? "").trim();
  // Six places: USDC's own precision, and plenty for EURe.
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(amountText)) {
    return refuse(400, { error: "amount must be a number with at most 6 decimals", code: "BAD_AMOUNT" });
  }
  const units = parseUnits(amountText, token.decimals);
  if (units <= 0n) return refuse(400, { error: "amount must be positive", code: "BAD_AMOUNT" });

  const to = await recipient(String(input.to ?? "").trim(), deps.resolveName);
  if (!to.ok) return refuse(to.status, { error: to.error, code: to.code });
  // The user confirmed one address on the check screen; send there or nowhere.
  const confirmed = String(input.confirmedAddress ?? "");
  if (!isAddress(confirmed, { strict: false }) || getAddress(confirmed) !== to.address) {
    return refuse(409, { error: "the address changed since you checked it — check it again", code: "ADDRESS_CHANGED", address: to.address });
  }
  if (payer.own.map((a) => a.toLowerCase()).includes(to.address.toLowerCase())) {
    return refuse(400, { error: "that is this account’s own address", code: "OWN_ADDRESS" });
  }
  const tokenAddresses = Object.values(sendable).map((t) => t.address.toLowerCase());
  if (to.address === "0x0000000000000000000000000000000000000000" || tokenAddresses.includes(to.address.toLowerCase())) {
    return refuse(400, { error: "tokens sent to that address are lost", code: "BURN_ADDRESS" });
  }

  try {
    if (await deps.screen(to.address)) return refuse(403, { error: SANCTIONED_ERROR, code: "SANCTIONED" });
  } catch (err) {
    console.error(`crypto send: screening failed: ${describeCause(err)}`);
    return refuse(503, { error: SCREENING_DOWN_ERROR, code: "SCREENING_UNAVAILABLE" });
  }

  const takes = await pageAddressTakes(to.address, to.name);
  if (takes && !takes.some((t) => t.toLowerCase() === token.address.toLowerCase())) {
    return refuse(409, {
      error: takes.length
        ? `${to.name ?? "That address"} is a Zold payment page that does not take ${token.label}; it would be stuck there. Send ${usdToken().symbol}, or ask them for their wallet address.`
        : `${to.name ?? "That address"} is a Zold payment page that can't take payments from here right now; it would be stuck there. Ask them for their wallet address.`,
      code: "PAGE_TOKEN_REFUSED",
    });
  }
  const amount = Number(formatUnits(units, token.decimals));
  let capEur: number;
  if (symbol === "EURE") capEur = amount;
  else {
    try {
      capEur = amount / (await deps.usdPerEur());
    } catch {
      // No rate, no send: the cap cannot be checked without one.
      return refuse(503, { error: "no exchange rate to check your daily limit against — try again shortly", code: "NO_RATE" });
    }
  }
  // Under a cent the books would show nothing (a €0.00 line reads as money in).
  if (capEur < 0.01) {
    return refuse(400, { error: "the smallest payment is worth €0.01", code: "BELOW_MINIMUM" });
  }
  let balance: bigint;
  try {
    balance = await deps.balanceOf(token.address, payer.safeAddress);
  } catch (err) {
    console.error(`crypto send: balance read failed for ${payer.logId}: ${describeCause(err)}`);
    return refuse(502, { error: "could not read your balance — try again", code: "BALANCE_UNAVAILABLE" });
  }
  if (balance < units) return refuse(409, { error: "that is more than your balance", code: "INSUFFICIENT_BALANCE" });

  const held = await store.holdDailyCap(payer.capKey, capEur, FX.DAILY_CAP_EUR, payer.spentToday);
  if (!held.ok) {
    return refuse(409, {
      error: `amount exceeds the daily limit of €${held.capEur.toFixed(2)} (€${held.usedEur.toFixed(2)} already used today)`,
      code: "DAILY_CAP",
    });
  }
  return { ok: true, token, symbol, units, to, capEur, balance, holdId: held.holdId };
}

/** Gas paid in the token being sent comes out of the same balance. */
function gasRefusal(c: CheckedSend, gas: PreparedSafeOperation["gasTokenCost"]): Refused | undefined {
  if (!gas || gas.token.toLowerCase() !== c.token.address.toLowerCase() || c.balance >= c.units + gas.units) return undefined;
  const most = c.balance > gas.units ? formatUnits(c.balance - gas.units, c.token.decimals) : "0";
  const sym = c.token.label;
  return refuse(409, {
    error: `gas for this payment is paid in ${sym} from the same balance; the most you can send is ${most} ${sym}`,
    code: "INSUFFICIENT_FOR_GAS",
    maxSendable: most,
  });
}

const withDefaults = ({
  resolveName = resolveEnsName,
  balanceOf = (token, holder) => publicClient.readContract({ address: token, abi: ERC20_BALANCE, functionName: "balanceOf", args: [holder] }),
  usdPerEur = () => eurPer("USD"),
  screen = isSanctioned,
  testUsdcAddress = testUsdc,
  sendTokens = () => tokens(testUsdcAddress()),
}: PreparerDeps) => ({ resolveName, balanceOf, usdPerEur, screen, sendTokens });

const COMPANY_SAFE_REFUSAL = refuse(403, {
  error: "This Safe belongs to a company. Its owners sign its payments in the company's queue, not here.",
  code: "COMPANY_SAFE",
});

/**
 * Every check a crypto send passes before the passkey sees it, and the
 * prepared operation, for a person's own Safe: the personal route and a
 * sole-trader payment run both call this. The caller has already checked the
 * session and that sending is on.
 */
export function createCryptoSendPreparer(deps: PreparerDeps) {
  const checks = withDefaults(deps);
  const prepare = deps.prepare ?? prepareTransferExecution;
  return async (user: User, input: CryptoSendInput): Promise<PreparedCryptoSend> => {
    // A company's Safe is signed in its queue, never by one passkey here.
    if ((await isCompanySafe(user.address)) || (user.passkeySafe && (await isCompanySafe(user.passkeySafe.address)))) return COMPANY_SAFE_REFUSAL;
    const blocked = safeDebitBlocker(user);
    if (blocked || !user.passkey?.credentialId || !user.passkeySafe) {
      return refuse(409, { error: blocked ?? "no passkey registered for this account", code: "NO_SAFE" });
    }
    const safe = user.passkeySafe;
    const credentialId = user.passkey.credentialId;
    const c = await checkSend(
      { safeAddress: safe.address, own: [user.address, safe.address], capKey: user.id, spentToday: async () => await safeFundedEurToday(user.id), logId: user.id },
      input,
      checks,
    );
    if (!c.ok) return c;
    const id = randomUUID();
    const deadline = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SEC;
    let challenge: string;
    try {
      const prepared = await prepare(safe, c.token.address, c.to.address, c.units);
      const short = gasRefusal(c, prepared.gasTokenCost);
      if (short) {
        await store.releaseCapHold(c.holdId);
        return short;
      }
      challenge = passkeySafeChallenge(prepared.challenge);
      await store.putPendingExecution("cryptoSend", id, { userId: user.id, expiresAt: deadline * 1000, challenge, plan: safe, userOperation: prepared.userOperation });
    } catch (err) {
      await store.releaseCapHold(c.holdId);
      if (err instanceof SafeVerifierMissingError) return refuse(err.status, { error: err.message, code: err.code });
      console.error(`crypto send: preparing the Safe operation failed for ${user.id}: ${describeCause(err)}`);
      return refuse(502, { error: `could not prepare the payment: ${redactedMessage(err)}`, code: "PREPARE_FAILED" });
    }
    const now = new Date().toISOString();
    const send: CryptoSend = {
      id,
      userId: user.id,
      ...(c.to.name ? { name: c.to.name } : {}),
      ...(input.draftId ? { draftId: input.draftId } : {}),
      to: c.to.address,
      token: c.symbol,
      amount: formatUnits(c.units, c.token.decimals),
      capEur: c.capEur,
      state: "CREATED",
      deadline,
      createdAt: now,
      updatedAt: now,
    };
    await store.addCryptoSendUnderHold(send, c.holdId);
    return { ok: true, send, safeExecution: { credentialId, challenge } };
  };
}

/**
 * The same checks for a company's org Safe, ending in an op on the org's
 * queue instead of a passkey prompt: the member who starts it queues it and
 * signs nothing, and the owners sign it at /orgs/:orgId/safe-ops. The daily
 * cap is the org Safe's (orgSafeCapKey), whoever queues. The send is linked
 * to its op and reads its state from it (liveCryptoSend).
 */
export function createCompanyCryptoSendPreparer(deps: PreparerDeps) {
  const checks = withDefaults(deps);
  return async (args: { org: Organisation; member: Member; userId: string; account: Account; input: CryptoSendInput }): Promise<PreparedCompanyCryptoSend> => {
    const { org, member, account, input } = args;
    let plan: OrgSafePlan;
    try {
      assertQueueOpen();
      plan = orgDebitSource(org, account);
    } catch (err) {
      if (err instanceof SafeOpRefusal || err instanceof OrgDebitRefusal) return refuse(err.status, { error: err.message, code: err.code });
      throw err;
    }
    const c = await checkSend(
      { safeAddress: plan.address, own: [plan.address], capKey: orgSafeCapKey(plan.address), spentToday: async () => await orgSafeSpentEurToday(plan.address), logId: org.id },
      input,
      checks,
    );
    if (!c.ok) return c;
    let op: PendingSafeOp;
    try {
      const { prepared } = await prepareOrgDebit({
        org,
        account,
        txs: transferExecutionTransactions(c.token.address, c.to.address, c.units),
        ...(deps.orgSafeReader ? { reader: deps.orgSafeReader } : {}),
        ...(deps.prepareOrg ? { prepare: deps.prepareOrg } : {}),
      });
      const short = gasRefusal(c, prepared.gasTokenCost);
      if (short) {
        await store.releaseCapHold(c.holdId);
        return short;
      }
      // The org and member as they are now: the checks above awaited.
      const orgNow = await store.findOrganisation(org.id);
      const memberNow = await store.findMember(member.id);
      if (!orgNow || !memberNow) throw new SafeOpRefusal(409, "CANNOT_QUEUE", "This organisation or your membership changed; nothing was created.");
      op = await queueSafeOp({
        org: orgNow,
        member: memberNow,
        safeAddress: plan.address,
        kind: "crypto-send",
        summary: `Send ${formatUnits(c.units, c.token.decimals)} ${c.token.label} to ${c.to.address}`,
        prepared,
      });
    } catch (err) {
      await store.releaseCapHold(c.holdId);
      if (err instanceof OrgDebitRefusal || err instanceof SafeOpRefusal || err instanceof SafeVerifierMissingError) {
        return refuse(err.status, { error: err.message, code: err.code });
      }
      console.error(`crypto send: preparing the org Safe operation failed for ${org.id}: ${describeCause(err)}`);
      return refuse(502, { error: `could not prepare the payment: ${redactedMessage(err)}`, code: "PREPARE_FAILED" });
    }
    const now = new Date().toISOString();
    const send: CryptoSend = {
      id: randomUUID(),
      userId: args.userId,
      orgId: org.id,
      safeOpId: op.id,
      ...(c.to.name ? { name: c.to.name } : {}),
      ...(input.draftId ? { draftId: input.draftId } : {}),
      to: c.to.address,
      token: c.symbol,
      amount: formatUnits(c.units, c.token.decimals),
      capEur: c.capEur,
      state: "CREATED",
      deadline: Math.floor(Date.parse(op.expiresAt) / 1000),
      createdAt: now,
      updatedAt: now,
    };
    await store.addCryptoSendUnderHold(send, c.holdId);
    return { ok: true, send, op };
  };
}

type SignRefusal = { status: number; code: string; error: string; invalidate?: string };

/**
 * What /authorize re-checks before a personal send, for a company send's op
 * before an owner's signature is taken (routes/business/safe-ops.ts): the
 * address is screened again (the op may wait 72 hours), and a payment run's
 * send must still pay what its line says to a payee that has not changed,
 * from the org Safe, with the feature still on. A refusal that can never
 * pass invalidates the op, and with it the send; a screen that does not
 * answer refuses this signature only.
 */
export async function companySendSignRefusal(op: PendingSafeOp, screen: (a: `0x${string}`) => Promise<boolean> = isSanctioned): Promise<SignRefusal | undefined> {
  if (op.kind !== "crypto-send") return undefined;
  const send = (await store.list("cryptoSends")).find((s) => s.safeOpId === op.id);
  if (!send || send.orgId !== op.orgId) {
    return { status: 409, code: "SEND_MISSING", error: "This payment's record is missing, so it cannot be signed.", invalidate: "its send is missing" };
  }
  if (!cryptoSendEnabled()) return { status: 503, code: "CRYPTO_SEND_OFF", error: "Sending to a crypto wallet is not open on this deployment." };
  try {
    if (await screen(send.to as `0x${string}`)) {
      return { status: 403, code: "SANCTIONED", error: SANCTIONED_ERROR, invalidate: "the address is on a sanctions list" };
    }
  } catch (err) {
    console.error(`crypto send ${send.id}: screening failed: ${describeCause(err)}`);
    return { status: 503, code: "SCREENING_UNAVAILABLE", error: SCREENING_DOWN_ERROR };
  }
  // Read with nothing awaited from here to the answer.
  const org = await store.findOrganisation(op.orgId);
  const draft = send.draftId ? (await store.findDraft(send.draftId)) : undefined;
  if (send.draftId) {
    const line = draft?.lines.length === 1 ? draft.lines[0] : undefined;
    const bound = !!draft && draft.orgId === op.orgId && draft.state === "EXECUTING" && !!draft.cryptoSendIds?.includes(send.id) && !!line
      && line.destination.address?.toLowerCase() === send.to.toLowerCase()
      && line.asset.toUpperCase() === send.token && Number(line.amount) === Number(send.amount);
    if (!bound || findDriftedLines(draft!, await contactsById(draft!.orgId)).length > 0) {
      return { status: 409, code: "INVALID_DATA", error: "The payee’s details changed since this payment was queued. Nothing was sent; create a new payment.", invalidate: "the payee changed before the send" };
    }
  }
  const account = draft?.source.kind === "account" ? (await store.findAccount(draft.source.accountId)) : (await store.accountsAtAddress(op.safeAddress)).find((a) => a.orgId === op.orgId);
  let source: string | undefined;
  try {
    if (!org || !account) throw new OrgDebitRefusal(409, "NOT_THE_ORG_SAFE", "missing");
    if (low(orgDebitSource(org, account).address) !== low(op.safeAddress)) throw new OrgDebitRefusal(409, "NOT_THE_ORG_SAFE", "moved");
    if (!can(org, "transfers.drafts").allowed) throw new OrgDebitRefusal(409, "NOT_ALLOWED", "feature");
  } catch (err) {
    if (!(err instanceof OrgDebitRefusal)) throw err;
    source = err.code;
  }
  if (source) {
    return { status: 409, code: "NOT_SENDER", error: "This company can no longer send from this account. Nothing was sent.", invalidate: "the company may no longer send from this account" };
  }
  return undefined;
}
const low = (a: string) => a.toLowerCase();

export function createCryptoSendsRouter({ requireUserSession, ...deps }: CryptoSendDeps) {
  const { resolveName = resolveEnsName, screen = isSanctioned } = deps;
  const prepareSend = createCryptoSendPreparer(deps);
  const router = express.Router();
  const off = (res: express.Response) =>
    res.status(503).json({ error: "sending to a crypto wallet is not open on this deployment", code: "CRYPTO_SEND_OFF" });

  router.post(
    "/users/:id/crypto-sends",
    wrap(async (req, res) => {
      if (!(await requireUserSession(req, res, req.params.id))) return;
      if (!cryptoSendEnabled()) return off(res);
      const user = await store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!(await requireCapability(user, "onchain_balance", res))) return;
      const b = req.body ?? {};
      const r = await prepareSend(user, { token: b.token, amount: b.amount, to: b.to, confirmedAddress: b.confirmedAddress });
      if (!r.ok) return res.status(r.status).json(r.body);
      res.status(201).json({ ...(await publicSend(r.send)), safeExecution: r.safeExecution });
    }),
  );

  router.post(
    "/crypto-sends/:id/authorize",
    wrap(async (req, res) => {
      const send = await store.findCryptoSend(req.params.id);
      if (!send) return res.status(404).json({ error: "send not found" });
      if (!(await requireUserSession(req, res, send.userId))) return;
      // A company's send is signed by its owners in the org's queue.
      if (send.safeOpId) return res.status(409).json({ error: "This payment is signed by the company’s owners in its queue, not here.", code: "COMPANY_SEND" });
      if (!cryptoSendEnabled()) return off(res);
      if (send.state !== "CREATED") return res.status(409).json({ error: `this send is ${send.state}` });
      if (Date.now() / 1000 > send.deadline) return res.status(410).json({ error: "the approval window closed — start the send again" });
      const pending = await store.findPendingExecution("cryptoSend", send.id);
      if (!pending || pending.userId !== send.userId) {
        return res.status(410).json({ error: "this send can no longer be approved — start it again" });
      }
      let user = (await store.findUser(send.userId)) as User;
      if (!(await requireCapability(user, "onchain_balance", res))) return;
      const a = req.body?.executionAssertion ?? {};
      if (!user.passkey?.publicKey) return res.status(409).json({ error: "no passkey registered for this account" });
      if (a.credentialId !== user.passkey.credentialId) {
        return res.status(403).json({ error: "passkey credential does not match this account" });
      }
      if (!a.authenticatorData || !a.clientDataJSON || !a.signature) {
        return res.status(400).json({ error: "executionAssertion requires authenticatorData, clientDataJSON and signature" });
      }
      try {
        const { signCount } = await verifyAssertionForChallenge(
          a.authenticatorData,
          a.clientDataJSON,
          a.signature,
          user.passkey.publicKey,
          user.passkey.signCount ?? 0,
          user.passkey.rpId ?? SECURITY.rpId,
          SECURITY.origins,
          pending.challenge,
          true,
        );
        const updated = await store.recordPasskeyUse(user.id, a.credentialId, signCount);
        if (!updated) throw new Error("this passkey is no longer the account's passkey");
        user = updated;
      } catch (err) {
        return res.status(401).json({ error: redactedMessage(err) });
      }
      // The signature fixes the address; a name pointing elsewhere now means
      // the owner changed it, or someone took it. Either way, do not send.
      if (send.name) {
        const now = await resolveName(send.name);
        // ENS down for a moment: nothing sent, and the same send can be approved again.
        if (!now.ok && now.code === "ENS_UNAVAILABLE") {
          return res.status(502).json({ error: `${send.name} could not be checked again just now — nothing was sent; try again`, code: now.code });
        }
        if (!now.ok || now.address !== send.to) {
          await store.updateCryptoSendFrom(send.id, ["CREATED"], { state: "FAILED", error: "the name's address changed before the send" });
          await store.dropPendingExecution("cryptoSend", send.id);
          return res.status(409).json({
            error: now.ok
              ? `${send.name} now points to a different address — nothing was sent; check it and start again`
              : `${send.name} could not be checked again (${now.error}) — nothing was sent`,
            code: now.ok ? "ADDRESS_CHANGED" : now.code,
          });
        }
      }
      // A list can change in the ten minutes the passkey prompt may wait.
      try {
        if (await screen(send.to as `0x${string}`)) {
          await store.updateCryptoSendFrom(send.id, ["CREATED"], { state: "FAILED", error: "the address is on a sanctions list" });
          await store.dropPendingExecution("cryptoSend", send.id);
          return res.status(403).json({ error: SANCTIONED_ERROR, code: "SANCTIONED" });
        }
      } catch (err) {
        console.error(`crypto send ${send.id}: screening failed: ${describeCause(err)}`);
        return res.status(503).json({ error: SCREENING_DOWN_ERROR, code: "SCREENING_UNAVAILABLE" });
      }
      const claim = await store.tx(async () => {
        // A payment run's payee is a saved contact and its signer the member
        // whose Safe backs the account. Checked in one transaction with the
        // claim, so an address-book edit cannot land in between.
        if (send.draftId) {
          // The org's row held: its members, contacts and feature change
          // under the same lock (routes/org-context.ts), so the checks below
          // hold until the claim commits.
          const orgId = (await store.findDraft(send.draftId))?.orgId;
          if (orgId) await store.lockOrganisation(orgId);
          const draft = await store.findDraft(send.draftId);
          const account = draft?.source.kind === "account" ? (await store.findAccount(draft.source.accountId)) : undefined;
          const member = draft && (await store.membersOf(draft.orgId)).find((m) => m.userId === send.userId && m.status === "active");
          // Read, not reconciled: the run is EXECUTING and stays so; this send failing fails it.
          // The send must still be this run's, and pay what its line says now:
          // a run reopened since could name another address.
          const line = draft?.lines.length === 1 ? draft.lines[0] : undefined;
          const bound = !!draft && draft.state === "EXECUTING" && !!draft.cryptoSendIds?.includes(send.id) && !!line
            && line.destination.address?.toLowerCase() === send.to.toLowerCase()
            && line.asset.toUpperCase() === send.token && Number(line.amount) === Number(send.amount);
          const drifted = !bound || findDriftedLines(draft!, await contactsById(draft!.orgId)).length > 0;
          // What /execute checked, again: the org may lose the feature, the account may be frozen.
          const org = draft && (await store.findOrganisation(draft.orgId));
          const mayStill = !!org && can(org, "transfers.drafts").allowed && !!account && accountIsSpendable(account).ok;
          if (drifted || !mayStill || account?.backingUserId !== send.userId || !member || !roleCan(member.role, "transfers.sign", orgEntity(org!))) {
            await store.updateCryptoSendFrom(send.id, ["CREATED"], { state: "FAILED", error: drifted ? "the payee changed before the send" : "the sender may no longer send from this account" });
            await store.dropPendingExecution("cryptoSend", send.id);
            return res.status(409).json(drifted
              ? { error: "the payee’s details changed since this payment was approved — nothing was sent", code: "INVALID_DATA" }
              : { error: "you can no longer send from this account — nothing was sent", code: "NOT_SENDER" });
          }
        }
        if (!(await store.claimCryptoSend(send.id))) {
          if ((await store.findCryptoSend(send.id))?.state === "CREATED" && Date.now() / 1000 > send.deadline) return res.status(410).json({ error: "the approval window closed — start the send again" });
          return res.status(409).json({ error: "this send was already submitted" });
        }
        // The prepared operation goes with the claim: a replayed approval finds neither.
        await store.dropPendingExecution("cryptoSend", send.id);
        return "claimed" as const;
      });
      if (claim !== "claimed") return;
      let op: Awaited<ReturnType<typeof submitPasskeySafeOperationWithReceipt>>;
      try {
        op = await submitPasskeySafeOperationWithReceipt(pending.plan, pending.userOperation, {
          authenticatorData: b64urlToBuf(a.authenticatorData),
          clientDataJSON: b64urlToBuf(a.clientDataJSON),
          signature: b64urlToBuf(a.signature),
        });
      } catch (err) {
        // Sent but unconfirmed stays SUBMITTED and keeps counting: it may land.
        const uncertain = err instanceof SafeOperationUncertainError;
        const done = await store.updateCryptoSend(send.id, {
          ...(uncertain ? { userOpHash: err.userOpHash, error: "sent, not yet confirmed" } : { state: "FAILED", error: redactedMessage(err) }),
        });
        console.error(`crypto send ${send.id}: submission ${uncertain ? "unconfirmed" : "failed"}: ${describeCause(err)}`);
        return res.status(uncertain ? 202 : 502).json(await publicSend(done));
      }
      // The chain has answered. A store error from here on is not a failed
      // submission: the send is never marked FAILED for it. The outcome write
      // may have committed (it stands) or not (the row stays SUBMITTED and
      // keeps counting, and gets the hash so the receipt sweep settles it).
      try {
        const done = await store.updateCryptoSend(send.id, {
          state: op.success === false ? "FAILED" : "SENT",
          ...(op.userOpHash ? { userOpHash: op.userOpHash } : {}),
          ...(op.txHash ? { txHash: op.txHash } : {}),
          ...(op.success === false ? { error: "included but reverted — nothing left your Safe except gas" } : {}),
        });
        return res.status(op.success === false ? 502 : 200).json(await publicSend(done));
      } catch (err) {
        console.error(`crypto send ${send.id}: outcome (userOp ${op.userOpHash}, tx ${op.txHash}) not recorded: ${describeCause(err)}`);
        if (op.userOpHash) {
          await store.updateCryptoSendFrom(send.id, ["SUBMITTED"], { userOpHash: op.userOpHash, error: "sent, not yet confirmed" })
            .catch((e) => console.error(`crypto send ${send.id}: hash not recorded either: ${describeCause(e)}`));
        }
        throw err;
      }
    }),
  );

  return router;
}
