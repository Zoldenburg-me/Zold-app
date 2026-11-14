/**
 * A recovered or imported Safe is owned by its passkey's verifier contract.
 * A verifier that never landed makes every signature fail on chain (AA24), so
 * the sweep deploys it and the prepare paths refuse before the passkey prompt.
 *
 * The deploy and the chain are stubbed; the real deploy ran on Base Sepolia
 * only through the sweep on the lease, not here.
 *
 * Run: npm run verifier-sweep:test
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { sweepMissingVerifiers } = await import("../services/api/src/recovery/recovered-passkey.js");
const { SafeVerifierMissingError } = await import("../services/api/src/wallet/candide.js");

const key = { x: "0x" + "11".repeat(32), y: "0x" + "22".repeat(32) };
const user = (id: string, safe: Record<string, unknown> | undefined) => ({ id, passkeySafe: safe }) as any;
const users = [
  user("recovered", { status: "active", address: "0xaa", passkeyPublicKey: key, recoveredAt: "2026-11-01T00:00:00Z" }),
  user("imported", { status: "active", address: "0xbb", passkeyPublicKey: key, importedAt: "2026-11-01T00:00:00Z" }),
  user("fresh", { status: "active", address: "0xcc", passkeyPublicKey: key }),
  user("pending", { status: "pending", address: "0xdd", passkeyPublicKey: key, recoveredAt: "2026-11-01T00:00:00Z" }),
  user("none", undefined),
];

const { deployVerifierForOwner } = await import("../services/api/src/recovery/recovered-passkey.js");
type Io = Parameters<typeof sweepMissingVerifiers>[1] & {};
/** A chain where nothing is deployed until a sent deploy confirms. */
const chain = (opts: { confirm?: boolean; failSend?: boolean; lands?: boolean } = {}) => {
  const sent: string[] = [];
  const code = new Set<string>();
  // The deploy is for the verifier read just before it; with `lands`, a success puts code there.
  let asked = "";
  const landing = new Map<string, string>();
  let release: (s: string) => void = () => {};
  const io: Io = {
    enabled: () => true,
    isDeployed: async (a) => { asked = a.toLowerCase(); return code.has(asked); },
    send: async (tx) => {
      if (opts.failSend) throw new Error("relay key has no ETH");
      sent.push(tx.data);
      const hash = `0x${String(sent.length).padStart(64, "0")}`;
      landing.set(hash, asked);
      return hash as `0x${string}`;
    },
    receipt: (hash) => (opts.confirm ? Promise.resolve("success").then((s) => { if (opts.lands) code.add(landing.get(hash)!); return s; }) : new Promise((ok) => { release = ok; })),
  };
  return { io, sent, code, opts, release: (s: string) => release(s) };
};

// Each Safe has its own key here, so each has its own verifier.
const keyed = (i: number) => ({ x: "0x" + String(i).repeat(64).slice(0, 64), y: key.y });
const swept = [
  user("recovered", { status: "active", address: "0xaa", passkeyPublicKey: keyed(1), recoveredAt: "2026-11-01T00:00:00Z" }),
  user("imported", { status: "active", address: "0xbb", passkeyPublicKey: keyed(2), importedAt: "2026-11-01T00:00:00Z" }),
  user("fresh", { status: "active", address: "0xcc", passkeyPublicKey: keyed(3) }),
  user("pending", { status: "pending", address: "0xdd", passkeyPublicKey: keyed(4), recoveredAt: "2026-11-01T00:00:00Z" }),
  user("none", undefined),
];
{
  const c = chain({ confirm: true });
  // The stub never puts code anywhere, so a confirmed receipt with no code is still a failure.
  assert.equal(await sweepMissingVerifiers(swept, c.io), 0, "a receipt without code at the address is not a deploy");
  assert.equal(c.sent.length, 2, "only active recovered or imported Safes are swept");
}
{
  const c = chain({ confirm: true, lands: true });
  assert.equal(await sweepMissingVerifiers(swept, c.io), 2, "a confirmed deploy with code at the address counts");
  assert.equal(c.code.size, 2);
  assert.equal(await sweepMissingVerifiers(swept, c.io), 0, "an already deployed verifier is skipped");
  assert.equal(c.sent.length, 2, "and nothing is sent for it");
}
{
  const c = chain({ failSend: true });
  assert.equal(await sweepMissingVerifiers(swept, c.io), 0, "a failed send is logged, and the sweep goes on");
}
console.log("   ok  the sweep deploys only active recovered or imported Safes, and one failure does not stop it");

{
  // A deploy that never confirms is sent once: not again by the request path, nor by the next sweep.
  const c = chain();
  const owner = { x: BigInt(keyed(5).x), y: BigInt(key.y) };
  const one = [user("stuck", { status: "active", address: "0xee", passkeyPublicKey: keyed(5), recoveredAt: "2026-11-01T00:00:00Z" })];
  const first = sweepMissingVerifiers(one, c.io);
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(c.sent.length, 1);
  assert.equal(await sweepMissingVerifiers(one, c.io), 0, "a second run while the first waits does nothing");
  assert.equal(await deployVerifierForOwner(owner, c.io), undefined, "a request path skips a deploy in flight");
  assert.equal(c.sent.length, 1, "still one send");
  c.release("reverted");
  await first;
  await new Promise((ok) => setTimeout(ok, 10));
  c.opts.confirm = true;
  await sweepMissingVerifiers(one, c.io);
  assert.equal(c.sent.length, 2, "once the chain answered, a later sweep may try again");
}
console.log("   ok  a deploy in flight is sent once, whichever path asks again");

const e = new SafeVerifierMissingError("0x2504a2ace3f9e25f8c4eb92d4982fb879004638e");
assert.equal(e.status, 409);
assert.equal(e.code, "VERIFIER_MISSING");
assert.match(e.message, /nothing was signed/);
console.log("   ok  a missing verifier is a 409 that says nothing was signed");

const candide = readFileSync(new URL("../services/api/src/wallet/candide.ts", import.meta.url), "utf8");
assert.equal(candide.match(/await assertVerifierOnChain\(plan, passkeyOwner\);\n  return paidUserOperation/g)?.length, 2,
  "both prepare paths (send-time and setup) check the verifier before building the op");
const server = readFileSync(new URL("../services/api/src/server.ts", import.meta.url), "utf8");
assert.match(server, /err instanceof SafeVerifierMissingError\) \{\n    return res\.status\(err\.status\)/, "the error handler answers it, not a 500");
assert.match(server, /setInterval\(runVerifierSweep/, "the sweep runs on a timer");
const passkey = readFileSync(new URL("../services/api/src/recovery/recovered-passkey.ts", import.meta.url), "utf8");
assert.doesNotMatch(passkey.slice(passkey.indexOf("export async function deployVerifierForOwner"), passkey.indexOf("async function confirmVerifier")), /await io\.receipt/, "a request path never waits for the receipt");
for (const file of ["routes/crypto-sends.ts", "routes/crypto-deposits.ts", "routes/recovery-zoldenburg.ts", "routes/recovery-turnkey.ts"]) {
  const src = readFileSync(new URL(`../services/api/src/${file}`, import.meta.url), "utf8");
  assert.match(src, /instanceof SafeVerifierMissingError[^\n]*\(e(rr)?\.status/, `${file} answers its own prepare errors without VERIFIER_MISSING`);
}
console.log("   ok  both prepares check it, the handler answers it, the sweep is scheduled, a request path does not wait for the receipt");

console.log("\nverifier-sweep: 4/4 checks passed");
