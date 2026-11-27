import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDE,
  passkeySafeRecoverySetupTransactions,
  smartAccountForPasskey,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} from "../services/api/src/wallet/candide.js";
import { passkeySafePlan, sharedNonceRunProblem, signsSafeDebit } from "../services/api/src/wallet/passkey-safe-plan.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const b64url = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

const jwk: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: b64url("1111111111111111111111111111111111111111111111111111111111111111"),
  y: b64url("2222222222222222222222222222222222222222222222222222222222222222"),
};
const guardian = "0x1111111111111111111111111111111111111111" as const;
const passkeyOwner = webauthnOwnerFromJwk(jwk);
assert.ok(passkeyOwner, "ES256 passkey JWK should produce Safe WebAuthn owner coordinates");

const passkeyOnlySafe = smartAccountForPasskey(passkeyOwner);
assert.match(passkeyOnlySafe.accountAddress, /^0x[0-9a-fA-F]{40}$/);
assert.equal(
  smartAccountForPasskey(passkeyOwner).accountAddress,
  passkeyOnlySafe.accountAddress,
  "the passkey Safe address must be deterministic",
);
const recoverySetup = passkeySafeRecoverySetupTransactions({
  address: passkeyOnlySafe.accountAddress as `0x${string}`,
  threshold: 1,
  passkeyPublicKey: webauthnOwnerToStore(passkeyOwner),
  recovery: {
    moduleAddress: CANDIDE.recoveryModuleAddress,
    guardianAddress: guardian,
    threshold: 1,
  },
});
assert.equal(recoverySetup.length, 2, "recovery setup should enable the module and add one guardian");
assert.equal(
  recoverySetup[0].to.toLowerCase(),
  passkeyOnlySafe.accountAddress.toLowerCase(),
  "the Safe itself must receive the enableModule call",
);
assert.equal(
  recoverySetup[1].to.toLowerCase(),
  CANDIDE.recoveryModuleAddress.toLowerCase(),
  "the recovery module must receive the guardian setup call",
);
/* Deployment installs recovery only; debits are UserOperations the passkey
   signs. The source assertion below keeps an allowance setup from quietly
   appearing. */
const candideSource = readFileSync(path.join(ROOT, "services/api/src/wallet/candide.ts"), "utf8");
assert.ok(
  !candideSource.includes("passkeySafeAllowanceSetupTransactions"),
  "Safe deployment must not install an allowance module or delegate",
);
assert.ok(
  !candideSource.includes("createAllowanceTransferMetaTransaction"),
  "no code path may spend through an allowance delegate transfer",
);

assert.equal(webauthnOwnerFromJwk({ ...jwk, crv: "P-384" }), null);

/* ---- New plans are passkey-only: no co-signer ---------------------------- */
const plan = passkeySafePlan(
  { address: "0x0000000000000000000000000000000000000000" } as any,
  { jwk, alg: "ES256" } as any,
);
assert.ok(plan, "an ES256 passkey must produce a Safe plan");
assert.equal(plan.threshold, 1, "a new Safe must be 1-of-1");
assert.equal((plan as any).cosignerAddress, undefined, "a new Safe must not list a co-signer owner");
assert.equal((plan as any).cosignerPolicy, undefined, "a new plan must not carry an allowance policy");
assert.equal(
  plan.address.toLowerCase(),
  passkeyOnlySafe.accountAddress.toLowerCase(),
  "a new plan's address must be the passkey-only counterfactual address",
);

// The co-signer is gone entirely: no code signs with it, requires it, or even
// models a Safe that lists it.
for (const rel of [
  "services/api/src/wallet/candide.ts",
  "services/api/src/routes/auth.ts",
  "services/api/src/routes/monerium.ts",
  "services/api/src/orchestrator.ts",
  "services/api/src/transfers/build.ts",
  "services/api/src/store/types.ts",
  "services/api/src/wallet/passkey-safe-plan.ts",
  "services/api/src/routes/recovery-candide.ts",
]) {
  const source = readFileSync(path.join(ROOT, rel), "utf8");
  assert.ok(!/cosigner/i.test(source), `${rel} must not mention a co-signer`);
}
const authRoutes = readFileSync(path.join(ROOT, "services/api/src/routes/auth.ts"), "utf8");
assert.ok(!authRoutes.includes("cosigner-removal"), "the co-signer removal route is gone with the key");

// A Candide recovery installs only the new passkey.
const recoverySource = readFileSync(path.join(ROOT, "services/api/src/routes/recovery-candide.ts"), "utf8");
assert.ok(
  /const newOwners: `0x\$\{string\}`\[\] = \[passkeyAccountAddress\(owner\)\];/.test(recoverySource),
  "recovery must install the new passkey as the only owner",
);
const configSource = readFileSync(path.join(ROOT, "services/api/src/config/production.ts"), "utf8");
assert.ok(!/fail\([^)]*CANDIDE_COSIGNER/.test(configSource), "production must not require a co-signer");

const deploymentSources = [
  "services/api/src/server.ts",
  "services/api/src/routes/auth.ts",
  "services/api/src/wallet/passkey-safe-plan.ts",
  "services/api/src/adapters/monerium-sandbox.ts",
  "services/api/src/wallet/candide.ts",
];
for (const rel of deploymentSources) {
  const source = readFileSync(path.join(ROOT, rel), "utf8");
  assert.ok(!source.includes("deploySmartAccount"), `${rel} must not expose an alternate Safe deployment helper`);
}
// The route lives in the auth router (the Safe's owner IS the passkey, so the
// ceremony and the deployment are one flow); server.ts mounts that router
// under /api. Check both halves, or a mounted-nowhere router would still pass.
const authSource = readFileSync(path.join(ROOT, "services/api/src/routes/auth.ts"), "utf8");
assert.ok(
  authSource.includes('"/users/:id/passkey-safe/deployment"'),
  "the passkey Safe deployment route must remain present",
);
const serverSource = readFileSync(path.join(ROOT, "services/api/src/server.ts"), "utf8");
assert.ok(
  /app\.use\("\/api", createAuthRouter\(/.test(serverSource),
  "the auth router must stay mounted under /api",
);

// A sole trader's bank run with a fee: each line's fee debit is its own Safe
// operation and all are prepared before the first is signed, so they would
// carry one nonce and only the first payee would be paid. Two payees with a
// positive fee are refused, before the draft is claimed or a transfer built.
const safe = "0x00000000000000000000000000000000000000aa" as const;
const sender: any = { address: safe.toUpperCase().replace("0X", "0x"), passkey: { credentialId: "cred" }, passkeySafe: { address: safe, status: "active", threshold: 1 } };
assert.equal(signsSafeDebit(sender), true, "an active passkey Safe that is the account's address, compared without case");
assert.equal(signsSafeDebit({ ...sender, passkey: undefined }), false);
assert.equal(signsSafeDebit({ ...sender, passkeySafe: { ...sender.passkeySafe, status: "planned" } }), false);
assert.equal(signsSafeDebit({ ...sender, address: "0x00000000000000000000000000000000000000bb" }), false);
assert.match(sharedNonceRunProblem(sender, 2, 0.99) ?? "", /€0\.99 fee.*one payee/s, "two payees, a positive fee: refused");
assert.equal(sharedNonceRunProblem(sender, 1, 0.99), null, "one payee is one operation");
assert.equal(sharedNonceRunProblem(sender, 200, 0), null, "no fee, no Safe debit: any number of payees");
assert.equal(sharedNonceRunProblem({ ...sender, passkeySafe: undefined }, 2, 0.99), null, "no passkey Safe, no prepared operation");
const draftsSource = readFileSync(path.join(ROOT, "services/api/src/routes/business/drafts.ts"), "utf8");
const exec = draftsSource.slice(draftsSource.indexOf('"/:orgId/drafts/:draftId/execute"'));
const refusal = exec.indexOf("sharedNonceRunProblem(user, plans.length, railFeeEur(\"sepa\"))");
assert.ok(refusal > 0, "draft execution asks sharedNonceRunProblem");
assert.ok(refusal < exec.indexOf("store.claimDraftExecution(") && refusal < exec.indexOf("buildTransferFromQuote("), "refused before the draft is claimed and before any transfer, so before any debit");
const buildSource = readFileSync(path.join(ROOT, "services/api/src/transfers/build.ts"), "utf8");
assert.match(buildSource, /debitWei > 0n && signsSafeDebit\(user\) && !HARNESS\.enabled/, "the builder prepares a Safe debit for exactly the users the run refusal counts");

console.log("PASSKEY SAFE PLAN TEST PASSED");
