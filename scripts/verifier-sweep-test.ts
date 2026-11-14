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

const asked: string[] = [];
let calls = 0;
const n = await sweepMissingVerifiers(users, async (owner) => {
  calls++;
  asked.push(`${owner.x}`);
  if (calls === 1) return "0xhash"; // deployed now
  throw new Error("relay key has no ETH"); // the second fails; the sweep goes on
});
assert.equal(calls, 2, "only active recovered or imported Safes are swept");
assert.equal(n, 1, "a failed deploy is not counted");
assert.equal(asked[0], BigInt(key.x).toString(), "the stored passkey key is the verifier's owner");
assert.equal(await sweepMissingVerifiers(users, async () => undefined), 0, "already deployed: nothing to do");
console.log("   ok  the sweep deploys only active recovered or imported Safes, and one failure does not stop it");

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
assert.match(passkey, /waitForTransactionReceipt/, "a deploy waits for its receipt");
console.log("   ok  both prepares check it, the handler answers it, the sweep is scheduled, the deploy waits for its receipt");

console.log("\nverifier-sweep: 3/3 checks passed");
