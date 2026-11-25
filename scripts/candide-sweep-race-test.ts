/**
 * Candide recovery under the async store, in process: the expiry sweep never
 * writes EXPIRED over a row that moved after it read the list, and the
 * operator's reject and the OTP route's on-chain execute claim the request
 * in one transaction each, so one of them sees the other.
 *
 * The full Candide flow (candide-recovery-test.ts) runs the API against a
 * chain; this covers the windows that only exist between awaits.
 *   npm run candide-sweep-race:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-candide-sweep-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:18545";
// Enabled, but nothing here reaches it: no row is past its grace period.
process.env.RECOVERY_SERVICE_URL = "http://127.0.0.1:9";

const { initStore, store } = await import("../services/api/src/store.js");
const { sweepCandideRecoveries } = await import("../services/api/src/routes/recovery-candide.js");

let failed = 0;
const check = async (name: string, fn: () => unknown) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e: any) { failed++; console.error(`  FAIL ${name}\n       ${e?.stack ?? e}`); }
};

await initStore();
const now = new Date().toISOString();
const row = (id: string, status: string) => ({
  id, userId: "u_c", safeAddress: `0x${"c".repeat(40)}`, mode: "candide", status, requestedAt: now,
  expiresAt: new Date(Date.now() - 1000).toISOString(), recoveryDelayHours: 1, guardianAddress: `0x${"9".repeat(40)}`,
  recoveryModuleAddress: `0x${"4".repeat(40)}`, factors: { kyc: "pending", otp: "pending", liveness: "pending", manualReview: "pending" }, candide: {},
});

await check("the sweep never writes EXPIRED over a row that moved after it read the list", async () => {
  await store.addRecoveryRequest(row("c-moved", "OTP_PENDING") as any);
  await store.addRecoveryRequest(row("c-idle", "PASSKEY_PENDING") as any);
  const realList = store.list;
  let moved = false;
  (store as any).list = async (name: any) => {
    const snap = await realList.call(store, name);
    // The OTP route executes on chain between the sweep's read and its write.
    if (name === "recoveryRequests" && !moved) {
      moved = true;
      await store.updateRecoveryRequest("c-moved", { status: "GRACE_PERIOD", candide: { finalizeAfter: new Date(Date.now() + 3600_000).toISOString() } as any });
    }
    return snap;
  };
  try {
    await sweepCandideRecoveries(new Date());
  } finally {
    (store as any).list = realList;
  }
  assert.equal((await store.findRecoveryRequest("c-moved"))!.status, "GRACE_PERIOD", "a recovery live on chain keeps its row");
  assert.equal((await store.findRecoveryRequest("c-idle"))!.status, "EXPIRED", "an unanswered one still expires");
});

await check("the reject, the expiry and the OTP route's execute each claim the request in one transaction", () => {
  const src = readFileSync(path.join(ROOT, "services/api/src/routes/recovery-candide.ts"), "utf8");
  const otp = src.slice(src.indexOf('"/recovery/candide/:id/otp"'));
  const claim = otp.indexOf("executing.add(request.id)");
  assert.ok(claim > 0 && otp.lastIndexOf("store.tx(", claim) > 0 && claim < otp.indexOf("await executeRecovery("), "claimed in a tx before the execute");
  const reject = src.slice(src.indexOf('"/admin/recoveries/candide/:id/reject"'));
  const tx = reject.indexOf("store.tx(");
  assert.ok(tx > 0 && tx < reject.indexOf("executing.has(r.id)") && reject.indexOf("executing.has(r.id)") < reject.indexOf("updateRecoveryRequestFrom("), "the reject checks the claim and writes conditionally, in one tx");
  const sweep = src.slice(src.indexOf("export async function sweepCandideRecoveries"), src.indexOf("export async function sweepCandideRecoveries") + 1500);
  assert.match(sweep, /executing\.has\(r\.id\)\) await store\.updateRecoveryRequestFrom\(r\.id, \["PASSKEY_PENDING", "OTP_PENDING"\], \{ status: "EXPIRED" \}\)/);
});

if (failed) { console.error(`CANDIDE SWEEP RACE TEST FAILED — ${failed}`); process.exit(1); }
console.log("CANDIDE SWEEP RACE TEST PASSED");
process.exit(0);
