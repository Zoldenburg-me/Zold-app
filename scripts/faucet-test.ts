/**
 * Testnet faucet test — local hardhat chain, no network.
 *
 * Proves the money-safety properties, not just the happy path:
 *  - a deployed Safe gets exactly the configured grant from the FAUCET wallet
 *    (not the deployer), recorded with its tx hash;
 *  - a second call for the same account pays NOTHING (the synchronous claim);
 *  - a dry faucet answers FAUCET_DRY with the claim released, and a later
 *    top-up can fund the same account after all;
 *  - an account without a deployed Safe, an unknown user and a zero address
 *    are refused;
 *  - a crash at every persistence boundary (before the claim, after it and
 *    before the send, after the send and before the hash is written, a
 *    receipt-wait timeout, sends still queued) leaves at most one grant per
 *    Safe after a restart, and an uncertain send is never resent: the claim
 *    stays for a person to reconcile by the signed hash, logged before the
 *    broadcast;
 *  - a failure before the broadcast (gas estimate, no gas money) or a
 *    broadcast the node refuses releases the claim, and a retry pays once.
 *    A crash is a snapshot of db.json at that instant plus a call that never
 *    resumes; a restart reloads that file and imports a fresh faucet module.
 *
 * What it cannot prove in-process: the real-money-chain refusal. CHAIN_ID is
 * frozen at first import, so it is checked in a child process started on
 * chain 8453, which must refuse to load the config at all.
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hardhatNode } from "./_free-port.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Its own node on a port the OS assigns: a fixed one collides with a parallel run.
const chain = await hardhatNode(ROOT);
const RPC = chain.url;
process.env.TRANSF_RPC_URL = RPC;
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";
process.env.TESTNET_FAUCET_EUR = "50";

const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);
const children: ChildProcess[] = [chain.child];
const bg = (cmd: string, args: string[]) => {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: process.env });
  children.push(c);
  return c;
};

async function waitRpc(timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("chain did not come up");
}

let passed = 0;
const check = (label: string, cond: boolean, detail = "") => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`   ok  ${label}`);
};

try {
  console.log("1/6 chain + deploy…");
  await waitRpc();
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit", env: process.env });
  assert.equal(dep.status, 0, "deploy failed");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  // The drip list, set after the deploy so the SYMBOL:address:amount form can
  // name a real local token: "USDX" is the local USDC under another name, with
  // a drip too large for the faucet to cover (the dry case).
  const local = JSON.parse(readFileSync(path.join(ROOT, "deployments.json"), "utf8"))["31337"];
  process.env.FAUCET_DRIPS = `EURe:5,USDC:2,USDX:${local.usdc}:1000000`;
  process.env.FAUCET_DRIPS_PER_IP = "4";

  const { initStore, store } = await import("../services/api/src/store.js");
  const { abis, addrs, eur, publicClient, writeAndWait, deployerWallet, faucetWallet } = await import("../services/api/src/chain.js");
  const { faucetEnabled, faucetFundSafe, drip, dripTokens } = await import("../services/api/src/faucet.js");
  const { capabilities } = await import("../services/api/src/capabilities.js");
  await initStore();
  assert.ok(faucetWallet, "faucet wallet missing");
  const faucetAddress = faucetWallet.account.address;

  const balanceOf = async (who: `0x${string}`) =>
    eur.fromWei((await publicClient.readContract({ address: addrs().eure, abi: abis.MockToken, functionName: "balanceOf", args: [who] })) as bigint);
  const mintToFaucet = (amount: number) =>
    writeAndWait(deployerWallet!, { address: addrs().eure, abi: abis.MockToken, functionName: "mint", args: [faucetAddress, eur.toWei(amount)] });

  async function addUser(name: string, opts: { address?: `0x${string}`; deployed?: boolean } = {}) {
    const user = {
      id: randomUUID(),
      name,
      country: "DE",
      address: opts.address ?? (`0x${randomBytes(20).toString("hex")}` as `0x${string}`),
      iban: "",
      kycStatus: "pending",
      createdAt: new Date().toISOString(),
      ...(opts.deployed === false ? {} : { wallet: { type: "candide-safe", deployed: true } }),
    } as any;
    await store.addUser(user);
    return user;
  }

  console.log("2/6 a deployed Safe gets exactly the grant, from the faucet wallet…");
  check("faucet is enabled on a local chain with a key and a grant", faucetEnabled());
  check("/api/health advertises the grant", (await capabilities()).faucetEur === 50);
  check("the faucet wallet is not the deployer", faucetAddress.toLowerCase() !== deployerWallet!.account.address.toLowerCase());
  await mintToFaucet(60);
  const deployerBefore = await balanceOf(deployerWallet!.account.address);
  const alice = await addUser("Faucet Alice");
  const a1 = await faucetFundSafe(alice.id);
  check("50 EURe arrived at the Safe", a1.ok && (await balanceOf(alice.address)) === 50);
  check("it came out of the faucet wallet", (await balanceOf(faucetAddress)) === 10 && (await balanceOf(deployerWallet!.account.address)) === deployerBefore);
  const rec = (await store.findUser(alice.id))?.faucet;
  check("the grant is recorded with its tx hash", rec?.grantedEur === 50 && /^0x[0-9a-f]{64}$/i.test(rec?.txHash ?? ""));

  console.log("3/6 a second call pays nothing, a parallel pair pays once…");
  const a2 = await faucetFundSafe(alice.id);
  check("a repeat call is ALREADY_GRANTED", !a2.ok && a2.code === "ALREADY_GRANTED");
  check("the balance is unchanged after a repeat call", (await balanceOf(alice.address)) === 50);
  await mintToFaucet(200);
  const carol = await addUser("Faucet Carol");
  const pair = await Promise.all([faucetFundSafe(carol.id), faucetFundSafe(carol.id)]);
  check("two parallel claims pay exactly once", pair.filter((r) => r.ok).length === 1 && (await balanceOf(carol.address)) === 50);

  console.log("4/6 a dry faucet refuses, and a top-up can retry…");
  // 210 - 50 (Carol) = 160 left; drain to below one grant.
  const dave = await addUser("Faucet Dave"), erin = await addUser("Faucet Erin"), finn = await addUser("Faucet Finn");
  for (const u of [dave, erin, finn]) await faucetFundSafe(u.id);
  const bob = await addUser("Faucet Bob");
  const b1 = await faucetFundSafe(bob.id);
  check("a dry faucet answers FAUCET_DRY and sends nothing", !b1.ok && b1.code === "FAUCET_DRY" && (await balanceOf(bob.address)) === 0);
  check("the claim was released so a retry stays possible", (await store.findUser(bob.id))?.faucet === undefined);
  await mintToFaucet(100);
  const b2 = await faucetFundSafe(bob.id);
  check("after a top-up the same account is funded", b2.ok && (await balanceOf(bob.address)) === 50);

  console.log("4b/6 a sent transfer whose receipt wait fails keeps the claim…");
  // The RPC drops while waiting for the receipt, after the transfer is out.
  const realWait = publicClient.waitForTransactionReceipt;
  (publicClient as any).waitForTransactionReceipt = async () => { throw new Error("receipt wait timed out"); };
  const gus = await addUser("Faucet Gus");
  let g1: Awaited<ReturnType<typeof faucetFundSafe>>;
  try { g1 = await faucetFundSafe(gus.id); } finally { (publicClient as any).waitForTransactionReceipt = realWait; }
  const kept = (await store.findUser(gus.id))?.faucet;
  check("the claim keeps the sent tx hash", g1.ok && /^0x[0-9a-f]{64}$/i.test(kept?.txHash ?? ""));
  const g2 = await faucetFundSafe(gus.id);
  check("a retry pays nothing: the account was paid once", !g2.ok && g2.code === "ALREADY_GRANTED" && (await balanceOf(gus.address)) === 50);

  console.log("4c/6 crash and restart at every persistence boundary…");
  const { DB_PATH } = await import("../services/api/src/store/db.js");
  const { linesFromFaucet } = await import("../services/api/src/documents.js");
  const { HttpRequestError, RpcRequestError } = await import("viem");
  await mintToFaucet(1000);
  type FaucetModule = typeof import("../services/api/src/faucet.js");
  let snapshot: Buffer | undefined;
  let crashed: () => void = () => {};
  // The process dies here: the disk holds what it holds, the call never resumes.
  const crash = () => {
    snapshot = readFileSync(DB_PATH);
    crashed();
    return new Promise<never>(() => {});
  };
  /** Crash on the next call of `obj[method]`, once; `before` runs the real call first.
   *  If the real call throws, or the crash point is never reached, the test fails
   *  instead of hanging with the hardhat child alive. */
  const crashOn = (obj: any, method: string, before = false) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`crash point ${method} not reached in 30 s`)), 30_000);
    crashed = () => { clearTimeout(timer); resolve(); };
    const real = obj[method];
    obj[method] = async (...args: unknown[]) => {
      obj[method] = real;
      if (before) {
        try { await real.apply(obj, args); } catch (err) { clearTimeout(timer); reject(err); throw err; }
      }
      return crash();
    };
  });
  let boot = 0;
  // A restart: the store reloads the crash's file and the faucet module comes
  // up fresh, its send queue empty.
  const restart = async (): Promise<FaucetModule> => {
    writeFileSync(DB_PATH, snapshot!);
    await initStore();
    return import(`../services/api/src/faucet.js?boot=${++boot}`);
  };
  const lostAnswer = () => new HttpRequestError({ url: RPC, details: "The request took too long to respond." });

  const hana = await addUser("Crash Hana");
  snapshot = readFileSync(DB_PATH);
  let f = await restart();
  const h1 = await f.faucetFundSafe(hana.id);
  check("crash before the claim: after a restart the Safe is funded, once", h1.ok && (await balanceOf(hana.address)) === 50);

  const ivan = await addUser("Crash Ivan");
  let armed = crashOn(publicClient, "readContract");
  void f.faucetFundSafe(ivan.id);
  await armed;
  f = await restart();
  const ivanClaim = (await store.findUser(ivan.id))?.faucet;
  check("crash after the claim, before the send: the claim survived the restart without a hash", ivanClaim?.txHash === "" && ivanClaim.grantedEur === 50);
  const i2 = await f.faucetFundSafe(ivan.id);
  check("…a retry is ALREADY_GRANTED, nothing is sent", !i2.ok && i2.code === "ALREADY_GRANTED" && (await balanceOf(ivan.address)) === 0);
  check("…and the statement shows no faucet credit for it", linesFromFaucet(ivanClaim).length === 0);

  const jule = await addUser("Crash Jule");
  armed = crashOn(faucetWallet, "sendRawTransaction", true);
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.join(" ")); realLog(...args); };
  try {
    void f.faucetFundSafe(jule.id);
    await armed;
  } finally { console.log = realLog; }
  f = await restart();
  const j2 = await f.faucetFundSafe(jule.id);
  check("crash after the send, before the hash is written: a retry is ALREADY_GRANTED and the Safe holds one grant",
    !j2.ok && j2.code === "ALREADY_GRANTED" && (await store.findUser(jule.id))?.faucet?.txHash === "" && (await balanceOf(jule.address)) === 50);
  const julesHash = logged.find((l) => l.includes(jule.id))?.match(/0x[0-9a-f]{64}/)?.[0] as `0x${string}` | undefined;
  const julesTx = julesHash ? await publicClient.getTransaction({ hash: julesHash }).catch(() => undefined) : undefined;
  check("…the hash was logged before the broadcast, and it names the transfer that landed",
    julesTx?.to?.toLowerCase() === addrs().eure.toLowerCase());

  const kai = await addUser("Crash Kai");
  armed = crashOn(publicClient, "waitForTransactionReceipt");
  void f.faucetFundSafe(kai.id);
  await armed;
  f = await restart();
  const k2 = await f.faucetFundSafe(kai.id);
  check("crash while waiting for the receipt: a retry is ALREADY_GRANTED and the Safe holds one grant",
    !k2.ok && k2.code === "ALREADY_GRANTED" && (await balanceOf(kai.address)) === 50);

  const lia = await addUser("Timeout Lia");
  (publicClient as any).waitForTransactionReceipt = async () => { throw new Error("receipt wait timed out"); };
  let l1: Awaited<ReturnType<FaucetModule["faucetFundSafe"]>>;
  try { l1 = await f.faucetFundSafe(lia.id); } finally { (publicClient as any).waitForTransactionReceipt = realWait; }
  snapshot = readFileSync(DB_PATH);
  f = await restart();
  const l2 = await f.faucetFundSafe(lia.id);
  check("a receipt-wait timeout, then a restart: the hash is on disk and a retry is ALREADY_GRANTED",
    l1.ok && (await store.findUser(lia.id))?.faucet?.txHash === l1.txHash && !l2.ok && l2.code === "ALREADY_GRANTED" && (await balanceOf(lia.address)) === 50);

  const queuedUsers = [await addUser("Queued Mo"), await addUser("Queued Nell"), await addUser("Queued Ola")];
  armed = crashOn(publicClient, "readContract");
  for (const qu of queuedUsers) void f.faucetFundSafe(qu.id);
  await armed;
  f = await restart();
  const qRetry = await Promise.all(queuedUsers.map((qu) => f.faucetFundSafe(qu.id)));
  const qHeld = await Promise.all(queuedUsers.map((qu) => balanceOf(qu.address)));
  check("a restart with sends still queued resends none of them: each claim stands, nothing arrived",
    qRetry.every((r) => !r.ok && r.code === "ALREADY_GRANTED") && qHeld.every((b) => b === 0));
  const pia = await addUser("After-restart Pia");
  const p1 = await f.faucetFundSafe(pia.id);
  check("…and the fresh queue still funds a new Safe", p1.ok && (await balanceOf(pia.address)) === 50);

  // The broadcast itself: the node takes the raw transaction, its answer is lost.
  const realBroadcast = faucetWallet.sendRawTransaction;
  const loseNextAnswer = () => {
    (faucetWallet as any).sendRawTransaction = async (...args: unknown[]) => {
      (faucetWallet as any).sendRawTransaction = realBroadcast;
      await (realBroadcast as any).apply(faucetWallet, args);
      throw lostAnswer();
    };
  };
  const quinn = await addUser("Lost-answer Quinn");
  loseNextAnswer();
  const q1 = await f.faucetFundSafe(quinn.id);
  check("a send whose answer is lost is FAUCET_FAILED and keeps the claim: the transfer may be out",
    !q1.ok && q1.code === "FAUCET_FAILED" && (await store.findUser(quinn.id))?.faucet?.txHash === "", JSON.stringify(q1));
  const q2 = await f.faucetFundSafe(quinn.id);
  check("…a retry is ALREADY_GRANTED: the Safe holds one grant, not two", !q2.ok && q2.code === "ALREADY_GRANTED" && (await balanceOf(quinn.address)) === 50);

  const rosa = await addUser("Refused Rosa");
  const realSimulate = publicClient.simulateContract;
  (publicClient as any).simulateContract = async () => { (publicClient as any).simulateContract = realSimulate; throw new Error("execution reverted"); };
  const r1 = await f.faucetFundSafe(rosa.id);
  check("a send refused before it went out releases the claim", !r1.ok && r1.code === "FAUCET_FAILED" && (await store.findUser(rosa.id))?.faucet === undefined);
  const r2 = await f.faucetFundSafe(rosa.id);
  check("…so a retry funds the Safe, once", r2.ok && (await balanceOf(rosa.address)) === 50);

  // Failures before the hand-over release the claim, whatever their kind: a
  // node that times out on the gas estimate has been sent nothing.
  const sami = await addUser("Estimate-fails Sami");
  const realPrepare = faucetWallet.prepareTransactionRequest;
  (faucetWallet as any).prepareTransactionRequest = async () => { (faucetWallet as any).prepareTransactionRequest = realPrepare; throw lostAnswer(); };
  const s1 = await f.faucetFundSafe(sami.id);
  check("a gas estimate (nonce, fee) read that times out before the send releases the claim", !s1.ok && s1.code === "FAUCET_FAILED" && (await store.findUser(sami.id))?.faucet === undefined, JSON.stringify(s1));
  const s2 = await f.faucetFundSafe(sami.id);
  check("…so a retry funds the Safe, once", s2.ok && (await balanceOf(sami.address)) === 50, JSON.stringify(s2));

  const tara = await addUser("No-gas Tara");
  const rpc = (method: string, params: unknown[]) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
  const gasHeld = (await rpc("eth_getBalance", [faucetAddress, "latest"])).result;
  await rpc("hardhat_setBalance", [faucetAddress, "0x0"]);
  let t1: Awaited<ReturnType<FaucetModule["faucetFundSafe"]>>;
  try { t1 = await f.faucetFundSafe(tara.id); } finally { await rpc("hardhat_setBalance", [faucetAddress, gasHeld]); }
  check("a faucet wallet without gas money releases the claim: nothing was sent", !t1.ok && t1.code === "FAUCET_FAILED" && (await store.findUser(tara.id))?.faucet === undefined && (await balanceOf(tara.address)) === 0, JSON.stringify(t1));
  const t2 = await f.faucetFundSafe(tara.id);
  check("…after the top-up a retry funds the Safe, once", t2.ok && (await balanceOf(tara.address)) === 50, JSON.stringify(t2));

  // The node answers the broadcast and refuses it: definitely not sent.
  const uma = await addUser("Broadcast-refused Uma");
  (faucetWallet as any).sendRawTransaction = async () => {
    (faucetWallet as any).sendRawTransaction = realBroadcast;
    throw new RpcRequestError({ body: {}, url: RPC, error: { code: -32000, message: "insufficient funds for gas * price + value" } });
  };
  const u1 = await f.faucetFundSafe(uma.id);
  check("a broadcast the node refuses (insufficient funds) releases the claim", !u1.ok && u1.code === "FAUCET_FAILED" && (await store.findUser(uma.id))?.faucet === undefined, JSON.stringify(u1));
  const u2 = await f.faucetFundSafe(uma.id);
  check("…so a retry funds the Safe, once", u2.ok && (await balanceOf(uma.address)) === 50, JSON.stringify(u2));

  console.log("5/6 accounts without a Safe are refused…");
  const noSafe = await addUser("No-Safe Nia", { deployed: false });
  const n = await faucetFundSafe(noSafe.id);
  check("an undeployed Safe answers NO_SAFE", !n.ok && n.code === "NO_SAFE" && (await store.findUser(noSafe.id))?.faucet === undefined);
  const u = await faucetFundSafe("no-such-user");
  check("an unknown user answers NO_SAFE", !u.ok && u.code === "NO_SAFE");
  const zero = await addUser("Zero Zoe", { address: "0x0000000000000000000000000000000000000000" });
  const z = await faucetFundSafe(zero.id);
  check("a zero address is never funded", !z.ok && (await store.findUser(zero.id))?.faucet === undefined);

  console.log("5b/6 the public drip: any address, chosen token, limits…");
  await writeAndWait(deployerWallet!, { address: addrs().usdc, abi: abis.MockToken, functionName: "mint", args: [faucetAddress, 100_000_000n] }); // 100 USDC
  await mintToFaucet(1000);
  const usdcOf = async (who: `0x${string}`) =>
    Number((await publicClient.readContract({ address: addrs().usdc, abi: abis.MockToken, functionName: "balanceOf", args: [who] })) as bigint) / 1e6;
  check("the page lists EURe, USDC and the configured extra token", dripTokens().map((t) => t.symbol).join(",") === "EURe,USDC,USDX");
  check("/api/health advertises the drip tokens", (await capabilities()).faucetTokens.join(",") === "EURe,USDC,USDX");
  const payer = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
  const d1 = await drip(payer, "eure", "10.0.0.1");
  check("a drip sends the chosen token to any address", d1.ok && (await balanceOf(payer)) === 5);
  const d2 = await drip(payer, "EURe", "10.0.0.2");
  check("the same address and token again is COOLDOWN, whatever the IP", !d2.ok && d2.code === "COOLDOWN" && !!d2.retryAt && (await balanceOf(payer)) === 5);
  const d3 = await drip(payer, "USDC", "10.0.0.1");
  check("another token to the same address is allowed, at its own decimals", d3.ok && (await usdcOf(payer)) === 2);
  const bad = await drip("0x1234", "EURe", "10.0.0.3");
  const self = await drip(faucetAddress, "EURe", "10.0.0.3");
  const unknown = await drip(payer, "DOGE", "10.0.0.3");
  check("a malformed address or the faucet itself is BAD_ADDRESS", !bad.ok && bad.code === "BAD_ADDRESS" && !self.ok && self.code === "BAD_ADDRESS");
  check("a token not in FAUCET_DRIPS is UNKNOWN_TOKEN", !unknown.ok && unknown.code === "UNKNOWN_TOKEN");
  const dry1 = await drip(payer, "USDX", "10.0.0.4");
  const dry2 = await drip(payer, "USDX", "10.0.0.4");
  check("a drip larger than the faucet holds is FAUCET_DRY and frees its slot", !dry1.ok && dry1.code === "FAUCET_DRY" && !dry2.ok && dry2.code === "FAUCET_DRY");
  const many = Array.from({ length: 5 }, () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`);
  const burst = await Promise.all(many.map((a, i) => drip(a, "EURe", `10.1.0.${i}`)));
  const landed = await Promise.all(many.map((a) => balanceOf(a)));
  check("five parallel drips from one wallet all land (sends are queued)", burst.every((r) => r.ok) && landed.every((b) => b === 5), JSON.stringify(burst.filter((r) => !r.ok)));
  const ipRuns = [];
  for (let i = 0; i < 5; i++) ipRuns.push(await drip(`0x${randomBytes(20).toString("hex")}`, "EURe", "10.9.9.9"));
  check("one IP gets FAUCET_DRIPS_PER_IP drips, then IP_LIMIT", ipRuns.slice(0, 4).every((r) => r.ok) && !ipRuns[4].ok && ipRuns[4].code === "IP_LIMIT");

  const lostTo = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
  loseNextAnswer();
  const lostDrip = await drip(lostTo, "EURe", "10.7.0.1");
  const lostAgain = await drip(lostTo, "EURe", "10.7.0.2");
  check("a drip whose answer is lost keeps its slot: the next one is COOLDOWN, the address got one drip",
    !lostDrip.ok && lostDrip.code === "FAUCET_FAILED" && !lostAgain.ok && lostAgain.code === "COOLDOWN" && (await balanceOf(lostTo)) === 5, JSON.stringify([lostDrip, lostAgain]));

  console.log("6/6 a real-money chain refuses to start with a faucet key…");
  const real = spawnSync(process.execPath, [bin("tsx"), "-e", 'import("./services/api/src/config.ts").catch((e) => { console.error(e.message); process.exit(1); })'], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TRANSF_CHAIN_ID: "8453", LOCAL_HARNESS: "", TRANSF_DB_PATH: path.join(ROOT, "data/never-written.json") },
  });
  check("chain 8453 with FAUCET_KEY set fails at config load", real.status !== 0 && /testnet-only/.test(real.stderr), real.stderr.slice(-300));
  const realDrips = spawnSync(process.execPath, [bin("tsx"), "-e", 'import("./services/api/src/config.ts").catch((e) => { console.error(e.message); process.exit(1); })'], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TRANSF_CHAIN_ID: "8453", LOCAL_HARNESS: "", FAUCET_KEY: "", TESTNET_FAUCET_EUR: "0", FAUCET_DRIPS: "EURe:5", TRANSF_DB_PATH: path.join(ROOT, "data/never-written.json") },
  });
  check("chain 8453 with only FAUCET_DRIPS set fails at config load too", realDrips.status !== 0 && /testnet-only/.test(realDrips.stderr), realDrips.stderr.slice(-300));

  console.log(`\nFAUCET TEST PASSED — ${passed} checks: one grant per Safe across crashes and restarts, no resend of an uncertain send, drips per address and token, limits hold, real-money chain refuses`);
} finally {
  for (const c of children) c.kill();
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
}
