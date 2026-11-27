/**
 * Candide recovery under the async store, in process: the expiry sweep never
 * writes EXPIRED over a row that moved after it read the list; the OTP
 * route's on-chain execute and the finalisation each hold a RELAYING reserve
 * (docs/postgres-store-design.md §2 rule 5) that a second caller, the
 * operator's reject and the expiry refuse, and that the sweep gives back
 * once it outlives the relay timeout. On db.json here, on Postgres 17 under
 * check:pg.
 *
 * The full Candide flow (candide-recovery-test.ts) runs the API against a
 * chain; this covers the windows that only exist between awaits.
 *   npm run candide-sweep-race:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-candide-sweep-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:18545";
// A recovery service that holds each request until the test lets it go,
// then refuses it: a finaliser's call stays in flight while another tries.
const held: (() => void)[] = [];
let serviceCalls = 0;
const service = createServer((_req, res) => {
  serviceCalls++;
  held.push(() => res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "not yet" })));
});
await new Promise<void>((r) => service.listen(0, "127.0.0.1", () => r()));
process.env.RECOVERY_SERVICE_URL = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { finalizeCandideRecovery, sweepCandideRecoveries } = await import("../services/api/src/routes/recovery-candide.js");
const { claimRelay, publicRecoveryRequest, RELAY_TIMEOUT_MS } = await import("../services/api/src/recovery.js");

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

await check("the execute holds a RELAYING reserve from OTP_PENDING: a second execute, the reject and the expiry refuse it; one cut off goes back", async () => {
  const src = readFileSync(path.join(ROOT, "services/api/src/routes/recovery-candide.ts"), "utf8");
  const otp = src.slice(src.indexOf('"/recovery/candide/:id/otp"'));
  const claim = otp.indexOf('claimRelay(request.id, "OTP_PENDING")');
  assert.ok(claim > 0 && claim < otp.indexOf("await executeRecovery("), "the reserve is claimed before the execute");
  assert.doesNotMatch(src, /executing\.(add|has)\(/, "no in-memory claim is left");
  await store.addRecoveryRequest(row("c-exec", "OTP_PENDING") as any);
  const claims = await Promise.all(Array.from({ length: 10 }, () => claimRelay("c-exec", "OTP_PENDING")));
  assert.equal(claims.filter(Boolean).length, 1, "ten executes in parallel: one holds the reserve");
  // The reject and the expiry write only from PASSKEY_PENDING or OTP_PENDING.
  assert.equal(await store.updateRecoveryRequestFrom("c-exec", ["PASSKEY_PENDING", "OTP_PENDING"], { status: "CANCELED" }), null, "the reject refuses a reserve");
  await sweepCandideRecoveries(new Date());
  const held = (await store.findRecoveryRequest("c-exec"))!;
  assert.equal(held.status, "RELAYING", "the expiry leaves it, past its expiresAt");
  assert.equal((publicRecoveryRequest(held) as any).status, "OTP_PENDING", "and it shows as the status it came from");
  // A process cut off holding it: past the relay timeout the sweep gives it back.
  await store.updateRecoveryRequest("c-exec", { relaying: { from: "OTP_PENDING", at: new Date(Date.now() - RELAY_TIMEOUT_MS - 1000).toISOString(), token: "t-cut" } });
  await sweepCandideRecoveries(new Date());
  const back = (await store.findRecoveryRequest("c-exec"))!;
  assert.deepEqual([back.status, back.relaying], ["OTP_PENDING", undefined]);
});

await check("two finalisers of one recovery: one holds the reserve and asks the service, the other is refused", async () => {
  await store.addRecoveryRequest({
    ...row("c-fin", "GRACE_PERIOD"),
    candide: { recoveryRequestId: "svc-1", newOwners: [`0x${"7".repeat(40)}`], newPasskey: { credentialId: "np" }, finalizeAfter: new Date(Date.now() - 1000).toISOString() },
  } as any);
  await store.addUser({ id: "u_c", name: "c", country: "DE", kycStatus: "approved", iban: "", address: `0x${"c".repeat(40)}`, passkeySafe: { address: `0x${"c".repeat(40)}`, status: "active" }, createdAt: now } as any);
  // Both read the row in its grace period, as the route and the sweep would.
  const snap = (await store.findRecoveryRequest("c-fin"))!;
  const first = finalizeCandideRecovery(snap);
  // The first holds the reserve while its call to the service is in flight.
  for (let i = 0; i < 200 && serviceCalls === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(serviceCalls, 1, "the first finaliser is asking the service");
  assert.equal((await store.findRecoveryRequest("c-fin"))!.status, "RELAYING");
  await assert.rejects(finalizeCandideRecovery(snap), /being finalized/, "the second is refused");
  for (const release of held.splice(0)) release();
  // Its owner read may fail where no chain answers; the reserve goes back either way.
  await first.catch(() => {});
  const after = (await store.findRecoveryRequest("c-fin"))!;
  assert.equal(after.status, "GRACE_PERIOD", "nothing recovered on chain: back to its grace period");
  assert.equal(after.relaying, undefined);
  assert.equal(serviceCalls, 1, "the service was asked once");
});

await check("a finaliser that ends late gives back only its own reserve: one the sweep cut off and a second finaliser took stays held", async () => {
  await store.addRecoveryRequest({
    ...row("c-late", "GRACE_PERIOD"),
    candide: { recoveryRequestId: "svc-2", newOwners: [`0x${"7".repeat(40)}`], newPasskey: { credentialId: "np" }, finalizeAfter: new Date(Date.now() - 1000).toISOString() },
  } as any);
  // The sweep below sees only this row in its grace period.
  await store.updateRecoveryRequest("c-fin", { status: "CANCELED" });
  const snap = (await store.findRecoveryRequest("c-late"))!;
  const calls = serviceCalls;
  const waitCalls = async (n: number) => { for (let i = 0; i < 200 && serviceCalls < n; i++) await new Promise((r) => setTimeout(r, 10)); };
  // A claims and asks the service; its call hangs past the relay timeout.
  const a = finalizeCandideRecovery(snap);
  await waitCalls(calls + 1);
  const aHeld = (await store.findRecoveryRequest("c-late"))!.relaying!;
  await store.updateRecoveryRequest("c-late", { relaying: { ...aHeld, at: new Date(Date.now() - RELAY_TIMEOUT_MS - 1000).toISOString() } });
  await sweepCandideRecoveries(new Date());
  assert.equal((await store.findRecoveryRequest("c-late"))!.status, "GRACE_PERIOD", "the sweep gave the cut-off reserve back");
  // B claims and asks the service.
  const b = finalizeCandideRecovery(snap);
  await waitCalls(calls + 2);
  const bHeld = (await store.findRecoveryRequest("c-late"))!.relaying!;
  assert.notEqual(bHeld.token, aHeld.token);
  // A's call ends now; its release and its finally must leave B's reserve.
  held.shift()!();
  await a.catch(() => {});
  const mid = (await store.findRecoveryRequest("c-late"))!;
  assert.deepEqual([mid.status, mid.relaying?.token], ["RELAYING", bHeld.token], "B still holds its reserve");
  await assert.rejects(finalizeCandideRecovery(snap), /being finalized/, "a third finaliser is refused while B runs");
  assert.equal(serviceCalls, calls + 2, "the service was asked by A and B only");
  for (const release of held.splice(0)) release();
  await b.catch(() => {});
  assert.deepEqual([(await store.findRecoveryRequest("c-late"))!.status, (await store.findRecoveryRequest("c-late"))!.relaying], ["GRACE_PERIOD", undefined], "B gives its own back");
});

service.close();
if (failed) { console.error(`CANDIDE SWEEP RACE TEST FAILED — ${failed}`); process.exit(1); }
console.log("CANDIDE SWEEP RACE TEST PASSED");
process.exit(0);
