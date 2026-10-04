/**
 * Zold Business → Settings → Access (public/business/access-model.js): who
 * can sign for a company login's Safe and who can recover it.
 *
 * Pins the rules that are easy to break unnoticed: a recovery check that
 * failed, or was only half answered, is never "none"; a guardian the chain
 * does not show is not a guardian; a member who is not the company login
 * reads nothing, and the company login reads only in its own company; a
 * guardian Zold did not set up is still listed; a second owner at threshold
 * 2 says Zold cannot send.
 *
 * What this cannot show: the screen in a browser, or a real chain read.
 * Offline.
 *
 *   npm run business:access:test
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const m: any = await import(pathToFileURL(path.join(ROOT, "services/api/public/business/access-model.js")).href);

const G = "0x00000000000000000000000000000000000000a1";
const C = "0x00000000000000000000000000000000000000c1";
const zNone = { available: true, guardianAddress: G, active: false, choice: null, requests: [], onChain: { moduleEnabled: false, guardians: [], isGuardian: false, pendingRecovery: null } };
const cNone = { available: true, guardianStatus: "none", channels: [], requests: [] };
const zSet = { ...zNone, active: true, choice: { choice: "zoldenburg", at: "2026-09-01T10:00:00Z" }, onChain: { moduleEnabled: true, guardians: [G], isGuardian: true, pendingRecovery: null } };
const cSet = { ...cNone, guardianStatus: "active", guardianAddress: C, channels: [{ channel: "email", target: "a***@x.de" }, { channel: "sms", target: "+49***12" }], onChain: { moduleEnabled: true, guardians: [C], threshold: 1, pendingRecovery: null } };

// ── recoveryStatus ──────────────────────────────────────────────────────────

{
  const r = m.recoveryStatus(cNone, zNone);
  assert.equal(r.status, "none", "both answered, no guardian: none");
  assert.equal(r.declined, false);
}
{
  const r = m.recoveryStatus(cNone, { ...zNone, choice: { choice: "declined", at: "2026-09-02T08:00:00Z" } });
  assert.equal(r.status, "none");
  assert.equal(r.declined, true, "a recorded refusal is said, not nagged");
  assert.equal(r.declinedAt, "2026-09-02T08:00:00Z");
}
assert.equal(m.recoveryStatus(null, null).status, "unknown", "no answer at all is not none");
{
  // A guardian switched off on this deployment is not asked (undefined): that
  // is an answer, not a failed check. Asked and failed (null) still is.
  assert.equal(m.recoveryStatus(undefined, zNone).status, "none", "codes off here, Zoldenburg says none");
  assert.equal(m.recoveryStatus(cNone, undefined).status, "none");
  assert.equal(m.recoveryStatus(undefined, zSet).status, "set");
  assert.equal(m.recoveryStatus(undefined, null).status, "unknown");
  const off = m.recoveryStatus(undefined, undefined);
  assert.equal(off.status, "none");
  assert.equal(off.offered, false, "neither guardian on here: said, not nagged");
}
assert.equal(m.recoveryStatus(cNone, null).status, "unknown", "Zoldenburg unanswered: its guardian may exist");
assert.equal(m.recoveryStatus(null, zNone).status, "unknown", "codes unanswered: that guardian may exist");
assert.equal(m.recoveryStatus(cNone, { ...zSet, onChain: undefined, onChainError: "rpc down" }).status, "unknown", "a guardian whose chain read failed is unknown");
assert.equal(m.recoveryStatus({ ...cSet, onChain: { error: "rpc down" } }, zNone).status, "unknown");
{
  const r = m.recoveryStatus(null, zSet);
  assert.equal(r.status, "unknown", "the codes call failed: a recovery through it would go unseen");
  assert.deepEqual(r.guardians.map((g: any) => g.kind), ["zoldenburg"], "the guardian that was read is still listed");
}
{
  const r = m.recoveryStatus(cSet, zSet);
  assert.equal(r.status, "set");
  assert.deepEqual(r.guardians.map((g: any) => g.kind), ["zoldenburg", "codes"]);
  assert.deepEqual(r.guardians[1].channels, [{ channel: "email", target: "a***@x.de" }, { channel: "sms", target: "+49***12" }]);
}
{
  // Stored as active, but the chain no longer shows it: the chain wins.
  const r = m.recoveryStatus(cNone, { ...zSet, onChain: { ...zSet.onChain, isGuardian: false, guardians: [] } });
  assert.equal(r.status, "none");
  const r2 = m.recoveryStatus({ ...cSet, onChain: { ...cSet.onChain, guardians: [] } }, zNone);
  assert.equal(r2.status, "none");
}
{
  // One guardian read fine, the other's chain read failed: not "set", since a
  // recovery on the unread one would go unseen. The guardian read is kept.
  const r = m.recoveryStatus(cSet, { ...zSet, onChain: undefined, onChainError: "rpc down" });
  assert.equal(r.status, "unknown");
  assert.deepEqual(r.guardians.map((g: any) => g.kind), ["codes"]);
  // A failed Zoldenburg read is unknown even with no Zoldenburg guardian stored.
  assert.equal(m.recoveryStatus(cNone, { ...zNone, onChain: undefined, onChainError: "rpc down" }).status, "unknown");
  assert.equal(m.recoveryStatus({ ...cNone, onChain: { error: "rpc down" } }, zNone).status, "unknown");
}
{
  // On chain but not in Zold's records: the chain wins this way too.
  const r = m.recoveryStatus(cNone, { ...zNone, onChain: { ...zNone.onChain, moduleEnabled: true, guardians: [G], isGuardian: true } });
  assert.equal(r.status, "set");
  const r2 = m.recoveryStatus({ ...cNone, guardianStatus: "pending", guardianAddress: C, onChain: { guardians: [C], pendingRecovery: null } }, zNone);
  assert.equal(r2.status, "set");
}
{
  // Neither guardian is offered here: said as such, never a call to set one up.
  const r = m.recoveryStatus({ ...cNone, available: false }, { ...zNone, available: false });
  assert.equal(r.status, "none");
  assert.equal(r.offered, false);
  assert.equal(m.recoveryStatus(cNone, { ...zNone, available: false }).offered, true);
}
{
  const pendingRecovery = { newOwners: ["0x00000000000000000000000000000000000000ee"], newThreshold: 1, executeAfter: 1790000000 };
  const r = m.recoveryStatus(cNone, { ...zSet, onChain: { ...zSet.onChain, pendingRecovery } });
  assert.equal(r.status, "pending");
  assert.equal(r.pending.executeAfter, 1790000000);
  // A request opened against the account counts, on either guardian.
  assert.equal(m.recoveryStatus(cNone, { ...zSet, requests: [{ id: "r1", status: "REVIEW_PENDING" }] }).status, "pending");
  assert.equal(m.recoveryStatus(cNone, { ...zSet, requests: [{ id: "r2", status: "OTP_PENDING" }] }).status, "pending");
  assert.equal(m.recoveryStatus(cNone, { ...zSet, requests: [{ id: "r3", status: "CANCELED" }] }).status, "set", "a closed request is not under way");
  // The app's recovery-alert screen reads Zoldenburg requests only; Business
  // must not send someone there for a request that screen will not show.
  assert.equal(m.recoveryStatus({ ...cSet, requests: [{ id: "r4", status: "PASSKEY_PENDING" }] }, zNone).status, "set");
  // A pending recovery is shown even when the other read failed.
  assert.equal(m.recoveryStatus(null, { ...zSet, onChain: { ...zSet.onChain, pendingRecovery } }).status, "pending");
}

{
  // A guardian on chain that Zold did not set up is listed, never "none":
  // it can start a recovery like any other.
  const X = "0x00000000000000000000000000000000000000f1";
  const zOther = { ...zNone, guardianAddress: G, onChain: { moduleEnabled: true, guardians: [X], isGuardian: false, pendingRecovery: null } };
  const r = m.recoveryStatus(cNone, zOther);
  assert.equal(r.status, "set");
  assert.deepEqual(r.guardians, [{ kind: "other", address: X }]);
  // Listed once though both reads see it; the known ones are not repeated.
  const both = m.recoveryStatus(
    { ...cSet, onChain: { ...cSet.onChain, guardians: [C, X] } },
    { ...zSet, guardianAddress: G, onChain: { ...zSet.onChain, guardians: [G, X.toUpperCase().replace("0X", "0x")] } },
  );
  assert.deepEqual(both.guardians.map((g: any) => g.kind), ["zoldenburg", "codes", "other"]);
  // With the codes read failed, its guardian is not taken for a stranger.
  assert.deepEqual(m.recoveryStatus(null, { ...zSet, onChain: { ...zSet.onChain, guardians: [G, C] } }).guardians.map((g: any) => g.kind), ["zoldenburg"]);
}

// ── signersView ─────────────────────────────────────────────────────────────

{
  const s = m.signersView({ safeAddress: "0xSafe", threshold: 1, owners: [{ address: "0xP", kind: "passkey" }], safeAppUrl: "https://app.safe.global/x" });
  assert.deepEqual(s.otherOwners, []);
  assert.equal(s.passkeyIsOwner, true);
  assert.equal(s.zoldCanSend, true);
  assert.equal(s.needed, "1 of 1");
}
{
  const s = m.signersView({ safeAddress: "0xSafe", threshold: 2, owners: [{ address: "0xP", kind: "passkey" }, { address: "0xO", kind: "other" }] });
  assert.deepEqual(s.otherOwners, ["0xO"]);
  assert.equal(s.zoldCanSend, false, "Zold never collects a second owner's signature");
  assert.equal(s.needed, "2 of 2");
}
assert.equal(m.signersView({ threshold: 1, owners: [{ address: "0xP", kind: "passkey" }, { address: "0xO", kind: "other" }] }).zoldCanSend, true, "1 of 2: the passkey alone signs");
{
  // Every other owner is listed, not just the first.
  const s = m.signersView({ threshold: 1, owners: [{ address: "0xP", kind: "passkey" }, { address: "0xA", kind: "other" }, { address: "0xB", kind: "other" }] });
  assert.deepEqual(s.otherOwners, ["0xA", "0xB"]);
  assert.equal(s.needed, "1 of 3");
}
{
  // The passkey removed in Safe{Wallet}: it signs nothing, whatever the threshold.
  const s = m.signersView({ threshold: 1, owners: [{ address: "0xO", kind: "other" }] });
  assert.equal(s.passkeyIsOwner, false);
  assert.equal(s.zoldCanSend, false);
}

// ── who reads ───────────────────────────────────────────────────────────────

assert.equal(m.isCompanyLogin({ id: "u1", accountType: "company" }), true);
assert.equal(m.isCompanyLogin({ id: "u2", accountType: "individual" }), false);
assert.equal(m.isCompanyLogin({ id: "u3" }), false);
assert.equal(m.isCompanyLogin(null), false);

{
  const calls: string[] = [];
  const api = async (p: string) => { calls.push(p); return {}; };
  const out = await m.loadAccess({ id: "u2", accountType: "individual", passkeySafe: { status: "active" } }, api);
  assert.equal(out, null, "a member who is not the company login gets nothing");
  assert.deepEqual(calls, [], "and nothing is read for them");
}
{
  const calls: string[] = [];
  const api = async (p: string) => {
    calls.push(p);
    if (p === "/api/health") return { capabilities: { emailSmsRecovery: true, zoldenburgRecovery: true } };
    if (p.endsWith("/safe/signers")) return { safeAddress: "0xSafe", threshold: 1, owners: [{ address: "0xP", kind: "passkey" }] };
    if (p.endsWith("/recovery/candide")) return cNone;
    if (p.endsWith("/recovery/zoldenburg")) return zSet;
    throw new Error(`unexpected ${p}`);
  };
  const out = await m.loadAccess({ id: "c1", accountType: "company", passkeySafe: { status: "active" } }, api);
  assert.deepEqual(calls.sort(), ["/api/health", "/api/users/c1/recovery/candide", "/api/users/c1/recovery/zoldenburg", "/api/users/c1/safe/signers"]);
  assert.equal(out.signers.needed, "1 of 1");
  assert.equal(out.recovery.status, "set");
  assert.equal(out.signersError, null);
}
{
  // The harness answers no Safe reads: said, never invented.
  const api = async (p: string) => {
    if (p.endsWith("/safe/signers")) throw Object.assign(new Error("signer settings need a real chain"), { code: "NO_CHAIN" });
    throw new Error("down");
  };
  const out = await m.loadAccess({ id: "c1", accountType: "company", passkeySafe: { status: "active" } }, api);
  assert.equal(out.signers, null);
  assert.equal(out.signersError, "signer settings need a real chain");
  assert.equal(out.recovery.status, "unknown");
}
{
  // Only the guardians switched on are asked: a 404 from one that is off
  // would otherwise read as "couldn't check" for ever.
  const calls: string[] = [];
  const api = async (p: string) => {
    calls.push(p);
    if (p === "/api/health") return { capabilities: { emailSmsRecovery: false, zoldenburgRecovery: true } };
    if (p.endsWith("/safe/signers")) return { safeAddress: "0xSafe", threshold: 1, owners: [{ address: "0xP", kind: "passkey" }] };
    if (p.endsWith("/recovery/zoldenburg")) return zSet;
    throw Object.assign(new Error("not found"), { status: 404 });
  };
  const out = await m.loadAccess({ id: "c1", accountType: "company", passkeySafe: { status: "active" } }, api);
  assert.ok(!calls.some((p) => p.endsWith("/recovery/candide")), "the switched-off guardian is not asked");
  assert.equal(out.recovery.status, "set");
  // Health unread: which guardians are on is unknown, so recovery is too.
  const down = await m.readGuardians("c1", async () => { throw new Error("down"); });
  assert.deepEqual(down, [null, null]);
}
{
  const out = await m.loadAccess({ id: "c1", accountType: "company", passkeySafe: { status: "planned" } }, async () => { throw new Error("no call expected"); });
  assert.equal(out.noSafe, true, "no Safe yet: nothing to read, said so");
}

// ── whose company this is ───────────────────────────────────────────────────

{
  const login = { id: "c1", accountType: "company" };
  const own = { id: "o1", type: "business", role: "owner" };
  // Its account spends from this login's Safe.
  assert.equal(m.isOwnCompanyOrg(login, { ...own, role: "admin" }, [{ backingUserId: "c1" }]), true);
  // Before any account is funded: the company it owns, nothing backed by anyone else.
  assert.equal(m.isOwnCompanyOrg(login, own, [{ currency: "EUR" }]), true);
  assert.equal(m.isOwnCompanyOrg(login, own, []), true);
  // Invited into another company: its Safe is not that company's account.
  assert.equal(m.isOwnCompanyOrg(login, { ...own, role: "admin" }, [{ backingUserId: "u9" }]), false, "a member elsewhere");
  assert.equal(m.isOwnCompanyOrg(login, { ...own, role: "viewer" }, []), false);
  assert.equal(m.isOwnCompanyOrg(login, own, [{ backingUserId: "u9" }]), false, "owner, but it spends from someone else");
  // Unread accounts say nothing; a person's login or a personal space never.
  assert.equal(m.isOwnCompanyOrg(login, own, null), false);
  assert.equal(m.isOwnCompanyOrg({ id: "u2", accountType: "individual" }, own, []), false);
  assert.equal(m.isOwnCompanyOrg(login, { ...own, type: "personal" }, []), false);
}

// ── where changes are made ──────────────────────────────────────────────────

assert.equal(m.APP_LINKS.signers, "/app?from=business#signers");
assert.equal(m.APP_LINKS.recovery, "/app?from=business#recovery-settings");
assert.equal(m.APP_LINKS.alert, "/app?from=business#recovery-alert");

console.log("business access: ok");
