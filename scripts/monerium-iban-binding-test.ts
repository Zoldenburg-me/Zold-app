/**
 * An IBAN this account stores must still pay into this account's Safe.
 *
 * Monerium attributes an IBAN to one address on one chain, and anyone holding
 * the Monerium login (another app, Monerium's own site) can point it
 * elsewhere with PATCH /ibans. Zold reads the IBAN's address when it first
 * stores it; verifyIbanBinding re-reads it later. When Monerium lists it on
 * another address or chain, the IBAN comes off the account (and off the org
 * accounts the Safe backs), funding goes to iban_pending, and the account
 * says where it went so the app can offer moving it back. Anything short of
 * a clear answer (read failed, IBAN not listed, listed twice) changes
 * nothing.
 *
 * The fake Monerium answers GET /ibans per bearer token, and the one pair of
 * API keys the activation-gate cases connect with. No network, no chain: the
 * adapter, the store and the Monerium router run in-process.
 *
 * Run: npm run monerium:iban-binding:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-iban-binding-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL = "http://127.0.0.1:8545"; // the router imports the operator keys; nothing here reads the chain
process.env.LOCAL_HARNESS = "";
process.env.MONERIUM_TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-iban-binding-32b";
process.env.MONERIUM_CLIENT_ID = "";
process.env.MONERIUM_CLIENT_SECRET = "";
process.env.MONERIUM_CHAIN = "base";
process.env.MONERIUM_IBAN_CHECK_MS = "300000";

/** The IBANs each bearer token sees at GET /ibans. */
const ibansOf = new Map<string, any[]>();
const fake = { down: false, reads: 0, calls: 0 };
/** The user's own API keys (client credentials) and the token they mint. */
const KEYS = { clientId: "own-keys-client", clientSecret: "own-keys-secret-0001", token: "tok-own-keys" };

const monerium = createServer((req, res) => {
  fake.calls++;
  const url = new URL(req.url ?? "/", "http://fake");
  const send = (code: number, b: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (fake.down) return send(503, { code: 503, status: "Service Unavailable" });
  if (url.pathname === "/auth/token") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      if (form.get("client_id") !== KEYS.clientId || form.get("client_secret") !== KEYS.clientSecret) return send(401, { error: "invalid_client" });
      send(200, { access_token: KEYS.token, token_type: "Bearer", expires_in: 3600 });
    });
    return;
  }
  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  const list = ibansOf.get(token);
  if (!list) return send(401, { code: 401, status: "Unauthorized" });
  if (url.pathname === "/ibans") { fake.reads++; return send(200, { ibans: list }); }
  if (url.pathname === "/auth/context") return send(200, { email: "own@example.com" });
  if (url.pathname === "/profiles") return send(200, { profiles: [{ id: PROFILE, kind: "personal", state: "approved" }] });
  if (url.pathname === "/addresses") return send(200, { addresses: [] });
  send(404, { code: 404, status: "Not Found" });
});
await new Promise<void>((r) => monerium.listen(0, "127.0.0.1", r));
process.env.MONERIUM_BASE_URL = `http://127.0.0.1:${(monerium.address() as any).port}`;

const { initStore, store } = await import("../services/api/src/store.js");
const { SECRETS } = await import("../services/api/src/stored-secrets.js");
const { publicUser } = await import("../services/api/src/users/public-user.js");
const { MONERIUM, SECURITY } = await import("../services/api/src/config.js");
const { createMoneriumRouter } = await import("../services/api/src/routes/monerium.js");
const { issueChallenge, stepUpBinding, verifyRegistration } = await import("../services/api/src/webauthn.js");
const { makeSoftwarePasskey } = await import("./_software-passkey.js");
const { verifyIbanBinding, applyIbanBinding, refreshPendingIban, ibanActivationRefusal } = await import("../services/api/src/adapters/monerium-sandbox.js");
const { accountBankOf } = await import("../services/api/src/routes/business/shared.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

initStore();
const now = new Date().toISOString();
const PROFILE = "22222222-aaaa-4bbb-8ccc-000000000001";
const OTHER = "0x00000000000000000000000000000000000000cc";

// The Monerium routes over HTTP, signed in as whichever user the path names.
const app = express();
app.use(express.json());
app.use("/api", createMoneriumRouter({ requireUserSession: (_req, _res, id) => ({ id: `s_${id}` }) }));
const api = app.listen(0, "127.0.0.1");
await new Promise((r) => api.once("listening", r));
const API = `http://127.0.0.1:${(api.address() as any).port}`;
const post = async (p: string, body: unknown) => {
  const r = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as any };
};
const ORIGIN = SECURITY.origins.find((o) => o.startsWith("http://localhost"))!;

/** An approved account with an active IBAN on its own OAuth connection. */
function addUser(n: number, opts: { ownCredentials?: boolean } = {}) {
  const id = `u_bind_${n}`;
  const token = `tok-${id}`;
  const address = `0x${String(n).repeat(40).slice(0, 40)}` as `0x${string}`;
  const iban = `DE8937040044053201300${n}`;
  store.addUser({
    id, name: id, country: "DE", kycStatus: "approved", createdAt: now, address, iban,
    funding: { mode: "sandbox", status: "active", moneriumProfileId: PROFILE },
    ...(opts.ownCredentials === false
      ? {}
      : { monerium: { connectedAt: now, method: "oauth", profileId: PROFILE, accessTokenEnc: SECRETS.moneriumAccessToken.seal(id, token) } }),
  } as any);
  return { id, token, address, iban };
}
const listed = (iban: string, address: string, chain: string = MONERIUM.chain) => ({ iban, address, chain, profile: PROFILE, bic: "MONEDEFF" });

console.log("\nDetection");

await check("an IBAN Monerium now lists on another address comes off the account, which says where it went", async () => {
  const u = addUser(1);
  ibansOf.set(u.token, [listed(u.iban, OTHER)]);
  const after = await verifyIbanBinding(store.findUser(u.id)!);
  assert.equal(after.iban, "");
  assert.equal(after.funding?.status, "iban_pending", "a move back is picked up by refreshPendingIban");
  assert.match(after.funding?.detail ?? "", new RegExp(`ending ${u.iban.slice(-4)}`));
  assert.match(after.funding?.detail ?? "", /0x0000…00cc/);
  assert.match(after.funding?.detail ?? "", /no longer pays into this account/);
  assert.deepEqual(
    { ...after.moneriumIbanElsewhere, seenAt: undefined },
    { iban: u.iban, address: OTHER, chain: MONERIUM.chain, profileId: PROFILE, seenAt: undefined },
  );
  assert.ok(after.moneriumIbanElsewhere?.seenAt);
  assert.equal(after.kycStatus, "approved", "approval is not taken back; only the IBAN is");
  const pub = publicUser(after) as any;
  assert.equal(pub.iban, "");
  assert.equal(pub.moneriumIbanElsewhere.address, OTHER, "the app needs it to offer the move back");
  assert.equal(pub.moneriumIbanElsewhere.iban, u.iban);
  const audit = store.auditFor(u.id, 50).find((e) => e.kind === "partner.iban_moved_elsewhere");
  assert.ok(audit, "the detection is in the audit log");
});

await check("the same address on another chain counts as elsewhere: deposits there are not this account's", async () => {
  const u = addUser(2);
  ibansOf.set(u.token, [listed(u.iban, u.address, "gnosis")]);
  const after = await verifyIbanBinding(store.findUser(u.id)!);
  assert.equal(after.iban, "");
  assert.equal(after.moneriumIbanElsewhere?.chain, "gnosis");
  assert.match(after.funding?.detail ?? "", /on gnosis/);
});

await check("an IBAN still on this Safe, on our chain or with no chain named, stays", async () => {
  const u = addUser(3);
  ibansOf.set(u.token, [listed(u.iban, u.address.toUpperCase().replace("0X", "0x"))]);
  assert.equal((await verifyIbanBinding(store.findUser(u.id)!)).iban, u.iban);
  const noChain = applyIbanBinding(store.findUser(u.id)!, [{ iban: u.iban, address: u.address, profile: PROFILE }]);
  assert.equal(noChain.iban, u.iban);
  assert.equal(noChain.moneriumIbanElsewhere, undefined);
});

console.log("\nFail closed");

await check("Monerium not answering changes nothing", async () => {
  const u = addUser(4);
  ibansOf.set(u.token, [listed(u.iban, OTHER)]);
  fake.down = true;
  try {
    const after = await verifyIbanBinding(store.findUser(u.id)!);
    assert.equal(after.iban, u.iban);
    assert.equal(after.funding?.status, "active");
    assert.equal(after.moneriumIbanElsewhere, undefined);
  } finally {
    fake.down = false;
  }
});

await check("an IBAN missing from Monerium's list, or listed twice, is no verdict and changes nothing", async () => {
  const u = addUser(5);
  const missing = applyIbanBinding(store.findUser(u.id)!, [listed("DE00000000000000000099", OTHER)]);
  assert.equal(missing.iban, u.iban);
  const twice = applyIbanBinding(store.findUser(u.id)!, [listed(u.iban, OTHER), listed(u.iban, u.address)]);
  assert.equal(twice.iban, u.iban);
  const empty = applyIbanBinding(store.findUser(u.id)!, []);
  assert.equal(empty.iban, u.iban);
  assert.equal(store.findUser(u.id)!.funding?.status, "active");
});

await check("an account without its own Monerium credentials is not read on anyone else's", async () => {
  const u = addUser(6, { ownCredentials: false });
  const reads = fake.reads;
  const after = await verifyIbanBinding(store.findUser(u.id)!);
  assert.equal(after.iban, u.iban);
  assert.equal(fake.reads, reads, "no read was made");
});

await check("one user is re-read at most once per MONERIUM_IBAN_CHECK_MS", async () => {
  const u = addUser(7);
  ibansOf.set(u.token, [listed(u.iban, u.address)]);
  await verifyIbanBinding(store.findUser(u.id)!);
  const reads = fake.reads;
  ibansOf.set(u.token, [listed(u.iban, OTHER)]);
  const after = await verifyIbanBinding(store.findUser(u.id)!);
  assert.equal(fake.reads, reads, "the second call within the interval reads nothing");
  assert.equal(after.iban, u.iban);
});

console.log("\nMoving back");

await check("an IBAN on our chain at this address again is re-attached and the elsewhere record cleared", async () => {
  const u = addUser(8);
  ibansOf.set(u.token, [listed(u.iban, OTHER)]);
  await verifyIbanBinding(store.findUser(u.id)!);
  assert.ok(store.findUser(u.id)!.moneriumIbanElsewhere);
  // Still elsewhere: the poller's re-check attaches nothing.
  assert.equal((await refreshPendingIban(store.findUser(u.id)!)).iban, "");
  ibansOf.set(u.token, [listed(u.iban, u.address)]);
  const back = await refreshPendingIban(store.findUser(u.id)!);
  assert.equal(back.iban, u.iban);
  assert.equal(back.funding?.status, "active");
  assert.equal(back.moneriumIbanElsewhere, undefined);
  assert.equal((publicUser(back) as any).moneriumIbanElsewhere, undefined);
});

await check("refreshPendingIban does not attach an IBAN that pays this address on another chain", async () => {
  const u = addUser(9);
  store.updateUser(u.id, { iban: "", funding: { mode: "sandbox", status: "iban_pending", moneriumProfileId: PROFILE } });
  ibansOf.set(u.token, [listed(u.iban, u.address, "gnosis")]);
  const after = await refreshPendingIban(store.findUser(u.id)!);
  assert.equal(after.iban, "");
  assert.equal(after.funding?.status, "iban_pending");
});

await check("an approved pending account with no record says where its IBAN pays now (the move back that never landed)", async () => {
  const u = addUser(11);
  // A move back accepted but not confirmed: no IBAN, pending, no elsewhere record.
  store.updateUser(u.id, { iban: "", funding: { mode: "sandbox", status: "iban_pending", moneriumProfileId: PROFILE, detail: "Monerium accepted moving it but does not show it here yet" } });
  ibansOf.set(u.token, [listed(u.iban, OTHER)]);
  const after = await refreshPendingIban(store.findUser(u.id)!);
  assert.equal(after.iban, "");
  assert.equal(after.moneriumIbanElsewhere?.iban, u.iban);
  assert.equal(after.moneriumIbanElsewhere?.address, OTHER);
  assert.equal((publicUser(after) as any).moneriumIbanElsewhere.address, OTHER, "the app offers Move IBAN back");
  const audits = () => store.auditFor(u.id, 50).filter((e) => e.kind === "partner.iban_moved_elsewhere").length;
  assert.equal(audits(), 1);
  await refreshPendingIban(store.findUser(u.id)!);
  assert.equal(audits(), 1, "the poller does not rewrite an unchanged place");
  ibansOf.set(u.token, [listed(u.iban, u.address)]);
  const back = await refreshPendingIban(store.findUser(u.id)!);
  assert.equal(back.iban, u.iban);
  assert.equal(back.moneriumIbanElsewhere, undefined);
});

await check("of several IBANs on the profile, the one the user asked to move here is named", async () => {
  const u = addUser(12);
  const asked = "DE89370400440532013099";
  store.updateUser(u.id, {
    iban: "",
    funding: { mode: "sandbox", status: "iban_pending", moneriumProfileId: PROFILE },
    moneriumIbanMoves: [{ iban: asked, profileId: PROFILE, fromAddress: OTHER, fromChain: "base", toAddress: u.address, toChain: "base", requestedAt: now }],
  } as any);
  ibansOf.set(u.token, [listed(u.iban, OTHER), listed(asked, OTHER)]);
  assert.equal((await refreshPendingIban(store.findUser(u.id)!)).moneriumIbanElsewhere?.iban, asked);
});

await check("several IBANs and no move asked for, or an account never approved: nothing is named", async () => {
  const u = addUser(13);
  store.updateUser(u.id, { iban: "", funding: { mode: "sandbox", status: "iban_pending", moneriumProfileId: PROFILE } });
  ibansOf.set(u.token, [listed(u.iban, OTHER), listed("DE89370400440532013098", OTHER)]);
  assert.equal((await refreshPendingIban(store.findUser(u.id)!)).moneriumIbanElsewhere, undefined);
  const p = addUser(14);
  store.updateUser(p.id, { iban: "", kycStatus: "pending", funding: { mode: "sandbox", status: "iban_pending", moneriumProfileId: PROFILE } });
  ibansOf.set(p.token, [listed(p.iban, OTHER)]);
  assert.equal((await refreshPendingIban(store.findUser(p.id)!)).moneriumIbanElsewhere, undefined, "activation offers the move for a new account");
});

console.log("\nActivation gate");

await check("only an approved account, or a pending one with its own Monerium connection and a bank segment, may activate an IBAN", () => {
  const u = { ...store.findUser(addUser(15).id)!, iban: "", kycStatus: "pending" as const };
  assert.equal(ibanActivationRefusal(u), undefined, "pending, connected, no segment (EU_FULL)");
  assert.equal(ibanActivationRefusal({ ...u, kycStatus: "approved" }), undefined);
  for (const kycStatus of ["rejected", "manual_review"] as const) {
    assert.equal(ibanActivationRefusal({ ...u, kycStatus })?.code, "IBAN_NOT_OFFERED", kycStatus);
  }
  const wallet = { ...u, segment: { value: "WALLET_ONLY" as const, reasonCode: "test", decidedAt: now, decidedBy: "system" as const } };
  assert.equal(ibanActivationRefusal(wallet)?.code, "IBAN_NOT_OFFERED", "wallet-only, though pending and connected");
  assert.equal(ibanActivationRefusal({ ...wallet, kycStatus: "approved" })?.code, "IBAN_NOT_OFFERED", "wallet-only, though approved");
  assert.equal(ibanActivationRefusal({ ...u, monerium: undefined })?.code, "MONERIUM_NOT_CONNECTED", "pending with no connection of its own");
});

/**
 * An approved account with an active IBAN, a passkey and an active Safe,
 * then refused: Monerium rejected it, is reviewing it, or its segment has no
 * bank account.
 */
async function addRefused(n: number, refusal: "rejected" | "manual_review" | "wallet-only") {
  const u = addUser(n);
  const key = await makeSoftwarePasskey(`gate-${n}`, ORIGIN);
  const reg = key.register(issueChallenge("register", u.id));
  const { credentialId, key: publicKey } = verifyRegistration(reg.attestation, reg.clientDataJSON, SECURITY.rpId, SECURITY.origins, u.id);
  store.updateUser(u.id, {
    passkey: { credentialId, publicKey, signCount: 0, rpId: SECURITY.rpId, createdAt: now },
    passkeySafe: { status: "active", address: u.address },
    ...(refusal === "wallet-only"
      ? { segment: { value: "WALLET_ONLY", reasonCode: "test", decidedAt: now, decidedBy: "system" } }
      : { kycStatus: refusal }),
  } as any);
  ibansOf.set(u.token, [listed(u.iban, u.address)]);
  ibansOf.set(KEYS.token, [listed(u.iban, u.address)]);
  return { ...u, stepUp: (action: string) => key.assert(issueChallenge("step_up", stepUpBinding(u.id, action))) };
}

await check("the poller does not attach an IBAN to a pending activation the account may no longer have", async () => {
  for (const [n, refused] of [[19, { kycStatus: "rejected" }], [20, { kycStatus: "manual_review" }], [21, { segment: { value: "WALLET_ONLY", reasonCode: "test", decidedAt: now, decidedBy: "system" } }]] as const) {
    const u = addUser(n);
    store.updateUser(u.id, { iban: "", ...refused, funding: { mode: "sandbox", status: "iban_pending", moneriumProfileId: PROFILE } } as any);
    ibansOf.set(u.token, [listed(u.iban, u.address)]);
    const after = await refreshPendingIban(store.findUser(u.id)!);
    assert.equal(after.iban, "", `${u.id}: no IBAN attached`);
    assert.equal(after.funding?.status, "iban_pending", u.id);
  }
});

for (const [n, refusal] of [[16, "rejected"], [17, "manual_review"], [18, "wallet-only"]] as const) {
  await check(`${refusal}: start, activate and move-iban turn the account away before any Monerium call`, async () => {
    const u = await addRefused(n, refusal);
    const calls = fake.calls;
    const start = await post(`/api/users/${u.id}/monerium/link-signature/start`, { profileId: PROFILE });
    assert.equal(start.status, 409, JSON.stringify(start.data));
    assert.equal(start.data.code, "IBAN_NOT_OFFERED");
    for (const route of ["activate", "move-iban"]) {
      const r = await post(`/api/users/${u.id}/monerium/${route}`, { profileId: PROFILE, iban: u.iban, confirm: "MOVE" });
      // A wallet-only segment is refused one step earlier, by the capability check.
      if (refusal === "wallet-only") assert.ok(r.status >= 400 && r.status < 500, `${route}: ${r.status} ${JSON.stringify(r.data)}`);
      else {
        assert.equal(r.status, 409, `${route}: ${JSON.stringify(r.data)}`);
        assert.equal(r.data.code, "IBAN_NOT_OFFERED", route);
      }
    }
    assert.equal(fake.calls, calls, "no request reached Monerium");
  });

  // wallet-only has no "monerium" capability, so the api-keys route refuses it outright.
  if (refusal === "wallet-only") continue;
  await check(`${refusal}: connecting API keys neither keeps nor attributes an IBAN`, async () => {
    const u = await addRefused(n + 10, refusal);
    const r = await post(`/api/users/${u.id}/monerium/api-keys`, {
      clientId: KEYS.clientId, clientSecret: KEYS.clientSecret, stepUp: await u.stepUp("monerium.connect"),
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const after = store.findUser(u.id)!;
    assert.equal(after.iban, undefined, "the IBAN Monerium lists on this Safe is not kept");
    assert.notEqual(after.funding?.status, "active");
    assert.equal(after.kycStatus, refusal);
    assert.match(after.funding?.detail ?? "", /can’t open a bank account/);
    assert.ok(!publicUser(after).iban, "and no bank details are shown");
  });
}

console.log("\nOrganisation accounts");

await check("an org account backed by the user drops the IBAN with the user's (the row stays) and gets it back", async () => {
  const u = addUser(10);
  store.addOrganisation({ id: "org_bind", type: "business", name: "Bind GmbH", legalName: "Bind GmbH", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now } as any);
  store.addAccount({ id: "acc_bind", orgId: "org_bind", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: { iban: u.iban }, address: u.address, backingUserId: u.id, createdAt: now, updatedAt: now });
  const org = store.findOrganisation("org_bind")!;
  assert.equal(accountBankOf(org)?.iban, u.iban);
  ibansOf.set(u.token, [listed(u.iban, OTHER)]);
  await verifyIbanBinding(store.findUser(u.id)!);
  const acc = store.findAccount("acc_bind")!;
  assert.ok(acc, "the account row is never deleted");
  assert.equal(acc.identifier.iban, undefined, "invoices and the company page stop printing it");
  assert.equal(accountBankOf(org), undefined);
  ibansOf.set(u.token, [listed(u.iban, u.address)]);
  await refreshPendingIban(store.findUser(u.id)!);
  assert.equal(store.findAccount("acc_bind")!.identifier.iban, u.iban);
  assert.equal(accountBankOf(org)?.iban, u.iban);
});

monerium.close();
api.close();
console.log(process.exitCode ? "\nMONERIUM IBAN BINDING TEST FAILED" : `\nMONERIUM IBAN BINDING TEST PASSED — ${passed}/${passed}`);
