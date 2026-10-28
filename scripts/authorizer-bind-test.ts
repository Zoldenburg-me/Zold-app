/**
 * Binding the device key (POST /users/:id/authorizer): the key being bound
 * must sign a single-use server challenge for this account and this address,
 * so an account can never bind an address it holds no key for.
 *
 * The passkey step-up is issued for that same address, so an approval for
 * one address cannot bind another.
 *
 * Offline: the route runs in-process on the hardhat harness, where the passkey
 * step-up is waived for an account without a passkey; one account holds a
 * software passkey to test the step-up's address binding.
 */
import "./_local-chain.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "authorizer-bind-")), "db.json");

const express = (await import("express")).default;
const { store } = await import("../services/api/src/store.js");
const { createTransferRouter } = await import("../services/api/src/routes/transfers.js");
const { newDevice, registerDevice } = await import("./device.js");
const { makeSoftwarePasskey } = await import("./_software-passkey.js");
const { issueChallenge, stepUpBinding, verifyRegistration } = await import("../services/api/src/webauthn.js");
const { SECURITY } = await import("../services/api/src/config.js");
const signTerms = (device: ReturnType<typeof newDevice>, typedData: any) => device.signTypedData(typedData);

const app = express();
app.use(express.json());
app.use("/api", createTransferRouter({ requireUserSession: () => true }));
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = async (p: string, body: unknown) => {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};
const api = async (p: string, body?: unknown) => {
  const r = await post(p, body);
  if (r.status >= 300) throw new Error(`${p}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

const makeUser = (id: string) => {
  store.addUser({
    id, name: id, email: `${id}@example.test`, country: "DE", kycStatus: "approved", iban: "",
    address: `0x${"aa".repeat(20)}`, createdAt: new Date().toISOString(),
  } as any);
  return id;
};
const challenge = (id: string, address: string) => api(`/api/users/${id}/authorizer/challenge`, { address });

let pass = 0;
const check = async (label: string, fn: () => Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

try {
  await check("an address with no proof of its key is refused", async () => {
    const id = makeUser("u-noproof");
    const r = await post(`/api/users/${id}/authorizer`, { address: newDevice().address });
    assert.equal(r.status, 401, JSON.stringify(r.body));
    assert.equal(store.findUser(id)!.authorizerAddress, undefined);
  });

  await check("the challenge route refuses a bad address, an unknown account and an unverified one", async () => {
    const id = makeUser("u-branches");
    assert.equal((await post(`/api/users/${id}/authorizer/challenge`, { address: "0x12" })).status, 400);
    assert.equal((await post(`/api/users/nobody/authorizer/challenge`, { address: newDevice().address })).status, 404);
    store.updateUser(id, { kycStatus: "pending" } as any);
    assert.equal((await post(`/api/users/${id}/authorizer/challenge`, { address: newDevice().address })).status, 409);
  });

  await check("a malformed nonce or signature is refused", async () => {
    const id = makeUser("u-malformed");
    const device = newDevice();
    const { typedData } = await challenge(id, device.address);
    const signature = await signTerms(device, typedData);
    for (const proof of [{ nonce: "0x12", signature }, { nonce: typedData.message.nonce, signature: "nothex" }, { nonce: typedData.message.nonce }]) {
      const r = await post(`/api/users/${id}/authorizer`, { address: device.address, proof });
      assert.deepEqual([r.status, r.body.code], [401, "AUTHORIZER_PROOF"], JSON.stringify(proof));
    }
    assert.equal(store.findUser(id)!.authorizerAddress, undefined);
  });

  await check("a signature by another key is refused", async () => {
    const id = makeUser("u-otherkey");
    const target = newDevice();
    const { typedData } = await challenge(id, target.address);
    const signature = await signTerms(newDevice(), typedData);
    const r = await post(`/api/users/${id}/authorizer`, { address: target.address, proof: { nonce: typedData.message.nonce, signature } });
    assert.equal(r.status, 401, JSON.stringify(r.body));
    assert.equal(store.findUser(id)!.authorizerAddress, undefined);
  });

  await check("a challenge for another address or account does not bind", async () => {
    const id = makeUser("u-cross");
    const other = makeUser("u-cross-other");
    const device = newDevice();
    // Issued to the other account for this same key.
    const theirs = (await challenge(other, device.address)).typedData;
    const r1 = await post(`/api/users/${id}/authorizer`, { address: device.address, proof: { nonce: theirs.message.nonce, signature: await signTerms(device, theirs) } });
    assert.equal(r1.status, 401, JSON.stringify(r1.body));
    // Issued to this account for another key.
    const elsewhere = newDevice();
    const mine = (await challenge(id, elsewhere.address)).typedData;
    const r2 = await post(`/api/users/${id}/authorizer`, { address: device.address, proof: { nonce: mine.message.nonce, signature: await signTerms(device, { ...mine, message: { ...mine.message, authorizer: device.address } }) } });
    assert.equal(r2.status, 401, JSON.stringify(r2.body));
    assert.equal(store.findUser(id)!.authorizerAddress, undefined);
  });

  await check("the key's own signature binds it, and the challenge is single use", async () => {
    const id = makeUser("u-good");
    const device = newDevice();
    const { typedData } = await challenge(id, device.address);
    assert.equal(typedData.primaryType, "AuthorizerBinding");
    const proof = { nonce: typedData.message.nonce, signature: await signTerms(device, typedData) };
    const r = await post(`/api/users/${id}/authorizer`, { address: device.address, proof });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(store.findUser(id)!.authorizerAddress, device.address);

    const replay = await post(`/api/users/${id}/authorizer`, { address: device.address, proof });
    assert.equal(replay.status, 200, "an already-bound address is a no-op");
    const id2 = makeUser("u-good-2");
    const { typedData: t2 } = await challenge(id2, device.address);
    const proof2 = { nonce: t2.message.nonce, signature: await signTerms(device, t2) };
    assert.equal((await post(`/api/users/${id2}/authorizer`, { address: device.address, proof: proof2 })).status, 201);
    store.updateUser(id2, { authorizerAddress: undefined } as any);
    assert.equal((await post(`/api/users/${id2}/authorizer`, { address: device.address, proof: proof2 })).status, 401, "a spent challenge");
  });

  await check("a passkey approval for one address cannot bind another", async () => {
    const id = makeUser("u-passkey");
    const ORIGIN = SECURITY.origins.find((o: string) => o.startsWith("http://localhost"))!;
    const key = await makeSoftwarePasskey("authorizer-bind", ORIGIN);
    const reg = key.register(issueChallenge("register", id));
    const { credentialId, key: publicKey } = verifyRegistration(reg.attestation, reg.clientDataJSON, SECURITY.rpId, SECURITY.origins, id);
    store.updateUser(id, { passkey: { credentialId, publicKey, signCount: 0, rpId: SECURITY.rpId, createdAt: new Date().toISOString() } } as any);

    const approved = newDevice();
    const other = newDevice();
    const forApproved = await challenge(id, approved.address);
    const forOther = (await challenge(id, other.address)).typedData;
    const otherProof = { nonce: forOther.message.nonce, signature: await signTerms(other, forOther) };
    // The passkey approved `approved`; the request binds `other`, with other's own valid proof.
    const r = await post(`/api/users/${id}/authorizer`, { address: other.address, proof: otherProof, stepUp: await key.assert(forApproved.approval.challenge) });
    assert.deepEqual([r.status, r.body.code], [401, "STEP_UP_INVALID"], JSON.stringify(r.body));
    assert.equal(store.findUser(id)!.authorizerAddress, undefined);
    // An approval for "a binding" in general, as /webauthn/challenge used to issue it, binds nothing.
    const generic = (await challenge(id, other.address)).typedData;
    const genericProof = { nonce: generic.message.nonce, signature: await signTerms(other, generic) };
    const g = await post(`/api/users/${id}/authorizer`, { address: other.address, proof: genericProof, stepUp: await key.assert(issueChallenge("step_up", stepUpBinding(id, "authorizer.bind"))) });
    assert.deepEqual([g.status, g.body.code], [401, "STEP_UP_INVALID"], JSON.stringify(g.body));

    const good = await challenge(id, approved.address);
    const proof = { nonce: good.typedData.message.nonce, signature: await signTerms(approved, good.typedData) };
    const ok = await post(`/api/users/${id}/authorizer`, { address: approved.address, proof, stepUp: await key.assert(good.approval.challenge) });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(store.findUser(id)!.authorizerAddress, approved.address);

    // A browser that lost the key: the passkey approves a new one in its place.
    const fresh = newDevice();
    const next = await challenge(id, fresh.address);
    const freshProof = { nonce: next.typedData.message.nonce, signature: await signTerms(fresh, next.typedData) };
    const bare = await post(`/api/users/${id}/authorizer`, { address: fresh.address, proof: freshProof });
    assert.deepEqual([bare.status, bare.body.code], [401, "STEP_UP_REQUIRED"], "no replacement without the passkey");
    const wrong = await post(`/api/users/${id}/authorizer`, { address: fresh.address, proof: freshProof, stepUp: await key.assert((await challenge(id, other.address)).approval.challenge) });
    assert.deepEqual([wrong.status, wrong.body.code], [401, "STEP_UP_INVALID"], "an approval for another address replaces nothing");
    assert.equal(store.findUser(id)!.authorizerAddress, approved.address);
    const swapped = await post(`/api/users/${id}/authorizer`, { address: fresh.address, proof: freshProof, stepUp: await key.assert(next.approval.challenge) });
    assert.equal(swapped.status, 201, JSON.stringify(swapped.body));
    assert.equal(store.findUser(id)!.authorizerAddress, fresh.address);
    const entry = store.auditFor(id).find((e: any) => e.kind === "user.authorizer_bound" && e.data.to === fresh.address.toLowerCase());
    assert.ok(entry, "the replacement is audited");
    assert.equal(entry.data.from, approved.address.toLowerCase());
  });

  await check("two bindings racing for an unbound account: one key wins, the other is refused", async () => {
    const id = makeUser("u-race");
    const [a, b] = [newDevice(), newDevice()];
    const proofFor = async (d: ReturnType<typeof newDevice>) => {
      const { typedData } = await challenge(id, d.address);
      return { address: d.address, proof: { nonce: typedData.message.nonce, signature: await signTerms(d, typedData) } };
    };
    const [ba, bb] = [await proofFor(a), await proofFor(b)];
    const results = await Promise.all([post(`/api/users/${id}/authorizer`, ba), post(`/api/users/${id}/authorizer`, bb)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], JSON.stringify(results.map((r) => r.body)));
    const winner = results[0].status === 201 ? a : b;
    assert.equal(store.findUser(id)!.authorizerAddress, winner.address);
  });

  await check("the test device helper binds through the same route", async () => {
    const id = makeUser("u-helper");
    const device = newDevice();
    await registerDevice(api, id, device);
    assert.equal(store.findUser(id)!.authorizerAddress, device.address);
  });

  console.log(`\n${pass} authorizer-bind checks passed`);
} finally {
  server.close();
}
