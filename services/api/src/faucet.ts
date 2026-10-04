/**
 * Testnet faucet — test tokens from the faucet wallet (FAUCET_KEY), so a test
 * account has something to send and a test payer has something to pay with.
 *
 * Two ways out, one wallet:
 *  - the GRANT: TESTNET_FAUCET_EUR of EURe, once per passkey Safe, sent when
 *    the Safe is deployed or claimed from Add money;
 *  - the DRIP: the public /faucet page — any address, any token in
 *    FAUCET_DRIPS, once per address and token per cooldown window, with a
 *    per-IP and a per-token cap on top.
 *
 * Every transfer is a plain ERC-20 send, so the crypto-in scanner records it
 * like any other inbound funding — nothing here writes balances or invents
 * money the chain does not show.
 *
 * Money-safety rules, in order of importance:
 *  - config.ts refuses to start with any faucet variable on a chain where EURe
 *    is real money or in production; faucetLive() re-checks;
 *  - a claim (grant row, drip slot) is taken synchronously before the first
 *    await (the authorize-race lesson), so two calls cannot pay twice;
 *  - a dry faucet, or a failure BEFORE the transfer is sent, releases the
 *    claim; once sent, the claim stands even if waiting for the receipt then
 *    fails — the transfer may still land, and releasing would pay twice;
 *  - sends are queued one at a time: parallel sends from one wallet would
 *    race for the same nonce;
 *  - a faucet problem never breaks onboarding.
 *
 * Drip limits live in memory and reset when the server restarts — a deploy,
 * on a testnet. The grant row is in the store and survives.
 */
import { formatUnits, parseUnits } from "viem";
import { usdToken } from "./usd-token.js";
import { CHAIN_ID, IS_PRODUCTION, IS_REAL_MONEY_CHAIN, TESTNET_FAUCET } from "./config.js";
import { addrs, eur, faucetWallet, publicClient } from "./chain.js";
import { store } from "./store.js";

const ERC20 = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UNAVAILABLE = "the test faucet could not send — try again later";

/** Is there a faucet wallet on a chain where tokens are not money? */
function faucetLive(): boolean {
  return Boolean(faucetWallet) && !IS_PRODUCTION && !IS_REAL_MONEY_CHAIN;
}

/** Does the Add money grant exist on this deployment? */
export function faucetEnabled(): boolean {
  return faucetLive() && TESTNET_FAUCET.grantEur > 0;
}

/* ---------------------------------------------------------------- sending */

let queue: Promise<unknown> = Promise.resolve();
/** Run `fn` after every earlier send has been handed to the node. */
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

type Sent = { kind: "dry"; have: bigint } | { kind: "sent"; txHash: `0x${string}`; reverted: boolean };

/**
 * Check the balance, then send — both inside the queue, so the balance is
 * read after the previous send was handed over. Throws only BEFORE the send;
 * once a hash exists it is returned, and a failed receipt wait counts as sent.
 */
async function sendToken(token: `0x${string}`, to: `0x${string}`, units: bigint, label: string): Promise<Sent> {
  const wallet = faucetWallet!;
  const out = await queued(async (): Promise<Sent> => {
    const have = await publicClient.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [wallet.account.address] });
    if (have < units) return { kind: "dry", have };
    const { request } = await publicClient.simulateContract({ account: wallet.account, address: token, abi: ERC20, functionName: "transfer", args: [to, units] });
    return { kind: "sent", txHash: await wallet.writeContract(request), reverted: false };
  });
  if (out.kind !== "sent") return out;
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: out.txHash });
    if (receipt.status !== "success") return { ...out, reverted: true };
  } catch (err: any) {
    console.warn(`faucet: ${label} ${out.txHash} sent but unconfirmed (${err?.message ?? err}); claim kept`);
  }
  return out;
}

/* ------------------------------------------------------------------ grant */

export type FaucetResult =
  | { ok: true; grantedEur: number; txHash: string }
  | { ok: false; code: "FAUCET_OFF" | "NO_SAFE" | "ALREADY_GRANTED" | "FAUCET_DRY" | "FAUCET_FAILED"; error: string };

export async function faucetFundSafe(userId: string): Promise<FaucetResult> {
  if (!faucetEnabled()) return { ok: false, code: "FAUCET_OFF", error: "no faucet on this deployment" };
  const user = store.findUser(userId);
  if (!user?.wallet?.deployed) return { ok: false, code: "NO_SAFE", error: "deploy your smart wallet first" };
  const to = user.address;
  if (!ADDRESS_RE.test(to) || /^0x0{40}$/.test(to)) return { ok: false, code: "NO_SAFE", error: "deploy your smart wallet first" };
  if (user.faucet) return { ok: false, code: "ALREADY_GRANTED", error: "this account already received its test EURe" };
  // Claim before the first await: nothing yields between the check above and
  // this write, so a concurrent second call sees the claim and returns.
  const grantEur = TESTNET_FAUCET.grantEur;
  store.updateUser(user.id, { faucet: { grantedEur: grantEur, txHash: "", at: new Date().toISOString() } });
  const release = () => store.updateUser(user.id, { faucet: undefined });
  let sent: Sent;
  try {
    sent = await sendToken(addrs().eure, to, eur.toWei(grantEur), `grant to ${user.id}`);
  } catch (err: any) {
    release();
    console.error(`faucet: funding ${user.id} failed: ${err?.message ?? err}`);
    return { ok: false, code: "FAUCET_FAILED", error: UNAVAILABLE };
  }
  if (sent.kind === "dry") {
    // Nothing was sent, so a top-up plus retry can still fund this account.
    release();
    console.warn(`faucet: ${faucetWallet!.account.address} holds ${eur.fromWei(sent.have)} EURe on chain ${CHAIN_ID}, below the ${grantEur} EURe grant — top it up; skipped ${user.id}`);
    return { ok: false, code: "FAUCET_DRY", error: "the test faucet is empty — try again later" };
  }
  if (sent.reverted) {
    // A reverted transfer moved nothing, so the account may claim again.
    release();
    console.error(`faucet: grant to ${to} (${user.id}) reverted: ${sent.txHash}`);
    return { ok: false, code: "FAUCET_FAILED", error: UNAVAILABLE };
  }
  store.updateUser(user.id, { faucet: { grantedEur: grantEur, txHash: sent.txHash, at: new Date().toISOString() } });
  console.log(`faucet: ${grantEur} EURe -> ${to} (${user.id}) ${sent.txHash}`);
  return { ok: true, grantedEur: grantEur, txHash: sent.txHash };
}

/* ------------------------------------------------------------------- drip */

export type DripToken = { symbol: string; amount: number; address: `0x${string}` };

/**
 * The public page's tokens, with the app's EURe and USDC resolved.
 *
 * A bare `USDC:amount` means the app's dollar token, so it is labelled by that
 * token's own symbol: on a staging chain it drips zUSD and must say so. An
 * entry with an address keeps the name it was given.
 */
export function dripTokens(): DripToken[] {
  if (!faucetLive()) return [];
  return TESTNET_FAUCET.drips.map((d) => {
    if (d.address) return { symbol: d.symbol, amount: d.amount, address: d.address };
    if (d.symbol === "EURe") return { symbol: d.symbol, amount: d.amount, address: addrs().eure };
    return { symbol: usdToken().symbol, amount: d.amount, address: addrs().usdc };
  });
}

export type DripResult =
  | { ok: true; symbol: string; amount: number; to: string; txHash: string }
  | { ok: false; code: "FAUCET_OFF" | "BAD_ADDRESS" | "UNKNOWN_TOKEN" | "COOLDOWN" | "IP_LIMIT" | "TOKEN_LIMIT" | "FAUCET_DRY" | "FAUCET_FAILED"; error: string; retryAt?: string };

const lastDrip = new Map<string, number>(); // `${address}:${symbol}` -> when
const ipDrips = new Map<string, number[]>();
const tokenDrips = new Map<string, number[]>();
const decimalsOf = new Map<string, number>();

const recent = (log: Map<string, number[]>, key: string, now: number) =>
  (log.get(key) ?? []).filter((t) => now - t < TESTNET_FAUCET.cooldownMs);

/** One drip of `symbol` to `address`, for a caller at `ip`. */
export async function drip(address: string, symbol: string, ip: string): Promise<DripResult> {
  const tokens = dripTokens();
  if (!tokens.length) return { ok: false, code: "FAUCET_OFF", error: "no faucet on this deployment" };
  const token = tokens.find((t) => t.symbol.toLowerCase() === String(symbol ?? "").toLowerCase());
  if (!token) return { ok: false, code: "UNKNOWN_TOKEN", error: `this faucet has ${tokens.map((t) => t.symbol).join(", ")}` };
  const to = String(address ?? "").trim();
  if (!ADDRESS_RE.test(to) || /^0x0{40}$/.test(to) || to.toLowerCase() === faucetWallet!.account.address.toLowerCase()) {
    return { ok: false, code: "BAD_ADDRESS", error: "enter a wallet address: 0x followed by 40 hex characters" };
  }
  const now = Date.now();
  const window = TESTNET_FAUCET.cooldownMs;
  const slot = `${to.toLowerCase()}:${token.symbol}`;
  const last = lastDrip.get(slot);
  if (last !== undefined && now - last < window) {
    return { ok: false, code: "COOLDOWN", error: `this address already got ${token.symbol} in the last ${TESTNET_FAUCET.cooldownMs / 3600_000} hours`, retryAt: new Date(last + window).toISOString() };
  }
  const byIp = recent(ipDrips, ip, now);
  if (byIp.length >= TESTNET_FAUCET.perIpPerWindow) {
    return { ok: false, code: "IP_LIMIT", error: "too many drips from your connection", retryAt: new Date(byIp[0] + window).toISOString() };
  }
  const byToken = recent(tokenDrips, token.symbol, now);
  if (byToken.length >= TESTNET_FAUCET.perTokenPerWindow) {
    return { ok: false, code: "TOKEN_LIMIT", error: `today's ${token.symbol} is handed out — try another token or come back later` };
  }
  // Claim all three before the first await, for the same reason as the grant.
  lastDrip.set(slot, now);
  ipDrips.set(ip, [...byIp, now]);
  tokenDrips.set(token.symbol, [...byToken, now]);
  const release = () => {
    if (lastDrip.get(slot) === now) lastDrip.delete(slot);
    ipDrips.set(ip, (ipDrips.get(ip) ?? []).filter((t) => t !== now));
    tokenDrips.set(token.symbol, (tokenDrips.get(token.symbol) ?? []).filter((t) => t !== now));
  };
  let sent: Sent;
  let decimals = 0;
  try {
    decimals = decimalsOf.get(token.address) ?? Number(await publicClient.readContract({ address: token.address, abi: ERC20, functionName: "decimals" }));
    decimalsOf.set(token.address, decimals);
    sent = await sendToken(token.address, to as `0x${string}`, parseUnits(String(token.amount), decimals), `${token.symbol} drip to ${to}`);
  } catch (err: any) {
    release();
    console.error(`faucet: ${token.symbol} drip to ${to} failed: ${err?.message ?? err}`);
    return { ok: false, code: "FAUCET_FAILED", error: UNAVAILABLE };
  }
  if (sent.kind === "dry") {
    release();
    console.warn(`faucet: ${faucetWallet!.account.address} holds ${formatUnits(sent.have, decimals)} ${token.symbol}, below one ${token.amount} drip — top it up`);
    return { ok: false, code: "FAUCET_DRY", error: `the faucet is out of ${token.symbol} — try another token or come back later` };
  }
  if (sent.reverted) {
    release();
    console.error(`faucet: ${token.symbol} drip to ${to} reverted: ${sent.txHash}`);
    return { ok: false, code: "FAUCET_FAILED", error: UNAVAILABLE };
  }
  console.log(`faucet: drip ${token.amount} ${token.symbol} -> ${to} ${sent.txHash}`);
  return { ok: true, symbol: token.symbol, amount: token.amount, to, txHash: sent.txHash };
}
