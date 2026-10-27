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
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { CHAIN_ID, cryptoSendEnabled, ENS_GATEWAY, FX, SECURITY } from "../config.js";
import { addrs, publicClient } from "../chain.js";
import { eurPer } from "../rates.js";
import { usdToken } from "../usd-token.js";
import { safeDebitBlocker, safeFundedEurToday } from "../orchestrator.js";
import { store, type CryptoSend, type User } from "../store.js";
import { requireKycApproved } from "../http/guards.js";
import { pendingCryptoSends, prunePendingCryptoSends } from "../http/pending.js";
import { redactedMessage, describeCause } from "../http/log-cause.js";
import { passkeySafeChallenge } from "../wallet/passkey-safe-plan.js";
import { prepareTransferExecution, SafeOperationUncertainError, submitPasskeySafeOperationWithReceipt } from "../wallet/candide.js";
import { b64urlToBuf, verifyAssertionForChallenge } from "../webauthn.js";
import { resolveEnsName, type EnsResolution } from "./ens.js";
import { wrap } from "./util.js";

/** How long the passkey prompt may wait, as for a transfer's terms. */
const AUTH_WINDOW_SEC = 10 * 60;

const ERC20_BALANCE = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface CryptoSendDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
  /** Tests stub these three; production reads ENS, the chain and rates.ts. */
  resolveName?: (name: string) => Promise<EnsResolution>;
  balanceOf?: (token: `0x${string}`, holder: `0x${string}`) => Promise<bigint>;
  usdPerEur?: () => Promise<number>;
  prepare?: typeof prepareTransferExecution;
}

const tokens = () => ({
  EURE: { address: addrs().eure, decimals: 18 },
  USDC: { address: usdToken().address, decimals: 6 },
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
export function pageAddressTakes(address: `0x${string}`, name?: string, now = Date.now()): `0x${string}`[] | undefined {
  const a = address.toLowerCase();
  const isSafeOf = (u: User) => [u.address, u.passkeySafe?.address].some((x) => x?.toLowerCase() === a);
  const owner = store.users.find((u) => u.paymentPage?.depositAddress?.toLowerCase() === a);
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
  if (ours && !store.users.some(isSafeOf)) return [];
  return undefined;
}

function publicSend(s: CryptoSend) {
  const { userId: _u, ...rest } = s;
  return rest;
}

export function createCryptoSendsRouter({
  requireUserSession,
  resolveName = resolveEnsName,
  balanceOf = (token, holder) => publicClient.readContract({ address: token, abi: ERC20_BALANCE, functionName: "balanceOf", args: [holder] }),
  usdPerEur = () => eurPer("USD"),
  prepare = prepareTransferExecution,
}: CryptoSendDeps) {
  const router = express.Router();
  const off = (res: express.Response) =>
    res.status(503).json({ error: "sending to a crypto wallet is not open on this deployment", code: "CRYPTO_SEND_OFF" });

  router.post(
    "/users/:id/crypto-sends",
    wrap(async (req, res) => {
      if (!requireUserSession(req, res, req.params.id)) return;
      if (!cryptoSendEnabled()) return off(res);
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireKycApproved(user, res)) return;
      const blocked = safeDebitBlocker(user);
      if (blocked || !user.passkey?.credentialId || !user.passkeySafe) {
        return res.status(409).json({ error: blocked ?? "no passkey registered for this account", code: "NO_SAFE" });
      }
      const b = req.body ?? {};
      const symbol = String(b.token ?? "").toUpperCase();
      if (symbol !== "EURE" && symbol !== "USDC") return res.status(400).json({ error: "token must be EURE or USDC", code: "BAD_TOKEN" });
      const token = tokens()[symbol];
      const amountText = String(b.amount ?? "").trim();
      // Six places: USDC's own precision, and plenty for EURe.
      if (!/^\d{1,12}(\.\d{1,6})?$/.test(amountText)) {
        return res.status(400).json({ error: "amount must be a number with at most 6 decimals", code: "BAD_AMOUNT" });
      }
      const units = parseUnits(amountText, token.decimals);
      if (units <= 0n) return res.status(400).json({ error: "amount must be positive", code: "BAD_AMOUNT" });

      const to = await recipient(String(b.to ?? "").trim(), resolveName);
      if (!to.ok) return res.status(to.status).json({ error: to.error, code: to.code });
      // The user confirmed one address on the check screen; send there or nowhere.
      const confirmed = String(b.confirmedAddress ?? "");
      if (!isAddress(confirmed, { strict: false }) || getAddress(confirmed) !== to.address) {
        return res.status(409).json({ error: "the address changed since you checked it — check it again", code: "ADDRESS_CHANGED", address: to.address });
      }
      const own = [user.address, user.passkeySafe.address].map((a) => a.toLowerCase());
      if (own.includes(to.address.toLowerCase())) {
        return res.status(400).json({ error: "that is this account’s own address", code: "OWN_ADDRESS" });
      }
      const tokenAddresses = Object.values(tokens()).map((t) => t.address.toLowerCase());
      if (to.address === "0x0000000000000000000000000000000000000000" || tokenAddresses.includes(to.address.toLowerCase())) {
        return res.status(400).json({ error: "tokens sent to that address are lost", code: "BURN_ADDRESS" });
      }

      const takes = pageAddressTakes(to.address, to.name);
      if (takes && !takes.some((t) => t.toLowerCase() === token.address.toLowerCase())) {
        const sym = symbol === "EURE" ? "EURe" : usdToken().symbol;
        return res.status(409).json({
          error: takes.length
            ? `${to.name ?? "That address"} is a Zold payment page that does not take ${sym}; it would be stuck there. Send ${usdToken().symbol}, or ask them for their wallet address.`
            : `${to.name ?? "That address"} is a Zold payment page that can't take payments from here right now; it would be stuck there. Ask them for their wallet address.`,
          code: "PAGE_TOKEN_REFUSED",
        });
      }
      const amount = Number(formatUnits(units, token.decimals));
      let capEur: number;
      if (symbol === "EURE") capEur = amount;
      else {
        try {
          capEur = amount / (await usdPerEur());
        } catch {
          // No rate, no send: the cap cannot be checked without one.
          return res.status(503).json({ error: "no exchange rate to check your daily limit against — try again shortly", code: "NO_RATE" });
        }
      }
      // Under a cent the books would show nothing (a €0.00 line reads as money in).
      if (capEur < 0.01) {
        return res.status(400).json({ error: "the smallest payment is worth €0.01", code: "BELOW_MINIMUM" });
      }
      let balance: bigint;
      try {
        balance = await balanceOf(token.address, user.passkeySafe.address);
      } catch (err) {
        console.error(`crypto send: balance read failed for ${user.id}: ${describeCause(err)}`);
        return res.status(502).json({ error: "could not read your balance — try again", code: "BALANCE_UNAVAILABLE" });
      }
      if (balance < units) return res.status(409).json({ error: "that is more than your balance", code: "INSUFFICIENT_BALANCE" });

      const held = store.holdDailyCap(user.id, capEur, FX.DAILY_CAP_EUR, () => safeFundedEurToday(user.id));
      if (!held.ok) {
        return res.status(409).json({
          error: `amount exceeds the daily limit of €${held.capEur.toFixed(2)} (€${held.usedEur.toFixed(2)} already used today)`,
          code: "DAILY_CAP",
        });
      }
      const id = randomUUID();
      const deadline = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SEC;
      let challenge: string;
      try {
        const prepared = await prepare(user.passkeySafe, token.address, to.address, units);
        // Gas paid in the token being sent comes out of the same balance.
        const gas = prepared.gasTokenCost;
        if (gas && gas.token.toLowerCase() === token.address.toLowerCase() && balance < units + gas.units) {
          store.releaseCapHold(held.holdId);
          const most = balance > gas.units ? formatUnits(balance - gas.units, token.decimals) : "0";
          const sym = symbol === "EURE" ? "EURe" : usdToken().symbol;
          return res.status(409).json({
            error: `gas for this payment is paid in ${sym} from the same balance; the most you can send is ${most} ${sym}`,
            code: "INSUFFICIENT_FOR_GAS",
            maxSendable: most,
          });
        }
        challenge = passkeySafeChallenge(prepared.challenge);
        prunePendingCryptoSends();
        pendingCryptoSends.set(id, { userId: user.id, expiresAt: deadline * 1000, challenge, plan: user.passkeySafe, userOperation: prepared.userOperation });
      } catch (err) {
        store.releaseCapHold(held.holdId);
        console.error(`crypto send: preparing the Safe operation failed for ${user.id}: ${describeCause(err)}`);
        return res.status(502).json({ error: `could not prepare the payment: ${redactedMessage(err)}`, code: "PREPARE_FAILED" });
      }
      const now = new Date().toISOString();
      const send: CryptoSend = {
        id,
        userId: user.id,
        ...(to.name ? { name: to.name } : {}),
        to: to.address,
        token: symbol,
        amount: formatUnits(units, token.decimals),
        capEur,
        state: "CREATED",
        deadline,
        createdAt: now,
        updatedAt: now,
      };
      store.addCryptoSendUnderHold(send, held.holdId);
      res.status(201).json({ ...publicSend(send), safeExecution: { credentialId: user.passkey.credentialId, challenge } });
    }),
  );

  router.post(
    "/crypto-sends/:id/authorize",
    wrap(async (req, res) => {
      const send = store.findCryptoSend(req.params.id);
      if (!send) return res.status(404).json({ error: "send not found" });
      if (!requireUserSession(req, res, send.userId)) return;
      if (!cryptoSendEnabled()) return off(res);
      if (send.state !== "CREATED") return res.status(409).json({ error: `this send is ${send.state}` });
      if (Date.now() / 1000 > send.deadline) return res.status(410).json({ error: "the approval window closed — start the send again" });
      prunePendingCryptoSends();
      const pending = pendingCryptoSends.get(send.id);
      if (!pending || pending.userId !== send.userId) {
        return res.status(410).json({ error: "this send can no longer be approved — start it again" });
      }
      let user = store.findUser(send.userId) as User;
      if (!requireKycApproved(user, res)) return;
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
        const updated = store.recordPasskeyUse(user.id, a.credentialId, signCount);
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
          store.updateCryptoSend(send.id, { state: "FAILED", error: "the name's address changed before the send" });
          pendingCryptoSends.delete(send.id);
          return res.status(409).json({
            error: now.ok
              ? `${send.name} now points to a different address — nothing was sent; check it and start again`
              : `${send.name} could not be checked again (${now.error}) — nothing was sent`,
            code: now.ok ? "ADDRESS_CHANGED" : now.code,
          });
        }
      }
      if (!store.claimCryptoSend(send.id)) return res.status(409).json({ error: "this send was already submitted" });
      pendingCryptoSends.delete(send.id);
      try {
        const op = await submitPasskeySafeOperationWithReceipt(pending.plan, pending.userOperation, {
          authenticatorData: b64urlToBuf(a.authenticatorData),
          clientDataJSON: b64urlToBuf(a.clientDataJSON),
          signature: b64urlToBuf(a.signature),
        });
        const done = store.updateCryptoSend(send.id, {
          state: op.success === false ? "FAILED" : "SENT",
          ...(op.userOpHash ? { userOpHash: op.userOpHash } : {}),
          ...(op.txHash ? { txHash: op.txHash } : {}),
          ...(op.success === false ? { error: "included but reverted — nothing left your Safe except gas" } : {}),
        });
        return res.status(op.success === false ? 502 : 200).json(publicSend(done));
      } catch (err) {
        // Sent but unconfirmed stays SUBMITTED and keeps counting: it may land.
        const uncertain = err instanceof SafeOperationUncertainError;
        const done = store.updateCryptoSend(send.id, {
          ...(uncertain ? { userOpHash: err.userOpHash, error: "sent, not yet confirmed" } : { state: "FAILED", error: redactedMessage(err) }),
        });
        console.error(`crypto send ${send.id}: submission ${uncertain ? "unconfirmed" : "failed"}: ${describeCause(err)}`);
        return res.status(uncertain ? 202 : 502).json(publicSend(done));
      }
    }),
  );

  return router;
}
