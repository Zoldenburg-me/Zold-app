import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, getAddress } from "viem";
import {
  CANDIDE,
  accountForPlan,
  passkeyAccountAddress,
  passkeySafeRecoverySetupTransactions,
  removeCosignerTransactions,
  smartAccountForPasskey,
  smartAccountForPasskeyCosigner,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} from "../services/api/src/wallet/candide.js";
import { passkeySafePlan } from "../services/api/src/wallet/passkey-safe-plan.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const b64url = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

const jwk: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: b64url("1111111111111111111111111111111111111111111111111111111111111111"),
  y: b64url("2222222222222222222222222222222222222222222222222222222222222222"),
};
const cosigner = "0x1111111111111111111111111111111111111111" as const;
const passkeyOwner = webauthnOwnerFromJwk(jwk);
assert.ok(passkeyOwner, "ES256 passkey JWK should produce Safe WebAuthn owner coordinates");

const safe = smartAccountForPasskeyCosigner(passkeyOwner, cosigner);
const passkeyOnlySafe = smartAccountForPasskey(passkeyOwner);
assert.match(safe.accountAddress, /^0x[0-9a-fA-F]{40}$/);
assert.match(passkeyOnlySafe.accountAddress, /^0x[0-9a-fA-F]{40}$/);
assert.equal(
  smartAccountForPasskeyCosigner(passkeyOwner, cosigner).accountAddress,
  safe.accountAddress,
  "passkey/co-signer Safe address must be deterministic",
);
assert.notEqual(
  passkeyOnlySafe.accountAddress.toLowerCase(),
  safe.accountAddress.toLowerCase(),
  "production co-signer policy must produce a different Safe than local passkey-only setup",
);
const recoverySetup = passkeySafeRecoverySetupTransactions({
  address: safe.accountAddress as `0x${string}`,
  threshold: 2,
  cosignerAddress: cosigner,
  passkeyPublicKey: webauthnOwnerToStore(passkeyOwner),
  recovery: {
    moduleAddress: CANDIDE.recoveryModuleAddress,
    guardianAddress: cosigner,
    threshold: 1,
  },
});
assert.equal(recoverySetup.length, 2, "recovery setup should enable the module and add one guardian");
assert.equal(
  recoverySetup[0].to.toLowerCase(),
  safe.accountAddress.toLowerCase(),
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

/* ---- The co-signer is retired: new plans are passkey-only ---------------
   Even with a co-signer address configured (legacy Safes still need one), a
   NEW plan must never list it as an owner. */
(CANDIDE as any).cosignerAddress = cosigner;
(CANDIDE as any).cosignerKey = `0x${"ab".repeat(32)}`;
const plan = passkeySafePlan(
  { address: "0x0000000000000000000000000000000000000000" } as any,
  { jwk, alg: "ES256" } as any,
);
assert.ok(plan, "an ES256 passkey must produce a Safe plan");
assert.equal(plan.threshold, 1, "a new Safe must be 1-of-1");
assert.equal(plan.cosignerAddress, undefined, "a new Safe must not list a co-signer owner");
assert.equal(plan.cosignerPolicy?.enabled, false);
assert.equal(
  plan.address.toLowerCase(),
  passkeyOnlySafe.accountAddress.toLowerCase(),
  "a new plan's address must be the passkey-only counterfactual address",
);

/* ---- Removing the co-signer from a legacy 2-of-2 Safe ------------------- */
const legacySafe = safe.accountAddress as `0x${string}`;
const passkeySigner = passkeyAccountAddress(passkeyOwner);
const REMOVE_OWNER_ABI = [{
  type: "function", name: "removeOwner", stateMutability: "nonpayable", outputs: [],
  inputs: [{ name: "prevOwner", type: "address" }, { name: "owner", type: "address" }, { name: "_threshold", type: "uint256" }],
}] as const;
const decodeRemoval = (txs: ReturnType<typeof removeCosignerTransactions>) => {
  assert.equal(txs.length, 1);
  assert.equal(txs[0].to.toLowerCase(), legacySafe.toLowerCase(), "removeOwner must be called ON the Safe itself");
  assert.equal(txs[0].value, 0n);
  const { functionName, args } = decodeFunctionData({ abi: REMOVE_OWNER_ABI, data: txs[0].data as `0x${string}` });
  assert.equal(functionName, "removeOwner");
  return args;
};
// Co-signer second in the owner list: prevOwner is the passkey signer.
let args = decodeRemoval(removeCosignerTransactions(legacySafe, [passkeySigner, cosigner], cosigner));
assert.equal(args[0].toLowerCase(), passkeySigner.toLowerCase());
assert.equal(args[1].toLowerCase(), cosigner.toLowerCase());
assert.equal(args[2], 1n, "the Safe must end at threshold 1");
// Co-signer first: prevOwner is Safe's sentinel.
args = decodeRemoval(removeCosignerTransactions(legacySafe, [cosigner, passkeySigner], cosigner));
assert.equal(args[0], "0x0000000000000000000000000000000000000001");
// Case-insensitive: getOwners returns checksummed addresses, env vars need not be.
const mixedCase = getAddress("0xabcdef0123456789abcdef0123456789abcdef01");
args = decodeRemoval(removeCosignerTransactions(legacySafe, [passkeySigner, mixedCase], mixedCase.toLowerCase() as `0x${string}`));
assert.equal(args[1], mixedCase, "the owner must be passed exactly as the chain lists it");
assert.throws(() => removeCosignerTransactions(legacySafe, [passkeySigner], cosigner), /not an owner/);
assert.throws(() => removeCosignerTransactions(legacySafe, [cosigner], cosigner), /only owner/);

// After removal the owner set no longer derives the address, so the account
// must be addressed directly — re-deriving would throw a mismatch.
const legacyPlan = {
  address: legacySafe,
  threshold: 1 as const,
  passkeyPublicKey: webauthnOwnerToStore(passkeyOwner),
};
assert.throws(() => accountForPlan(legacyPlan), /does not match/, "a 1-of-1 derivation cannot reach a 2-of-2 address");
assert.equal(
  accountForPlan({ ...legacyPlan, cosignerRemovedAt: new Date().toISOString() }).account.accountAddress.toLowerCase(),
  legacySafe.toLowerCase(),
);

// A Candide recovery installs only the new passkey — it never carries the
// co-signer over. And the removal route must stay present.
const recoverySource = readFileSync(path.join(ROOT, "services/api/src/routes/recovery-candide.ts"), "utf8");
assert.ok(
  /const newOwners: `0x\$\{string\}`\[\] = \[passkeyAccountAddress\(owner\)\];/.test(recoverySource),
  "recovery must install the new passkey as the only owner",
);
const authRoutes = readFileSync(path.join(ROOT, "services/api/src/routes/auth.ts"), "utf8");
assert.ok(authRoutes.includes('"/users/:id/passkey-safe/cosigner-removal"'), "the co-signer removal route must remain present");
const configSource = readFileSync(path.join(ROOT, "services/api/src/config.ts"), "utf8");
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

console.log("PASSKEY SAFE PLAN TEST PASSED");
