import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDE,
  passkeySafeRecoverySetupTransactions,
  smartAccountFor,
  smartAccountForPasskeyCosigner,
  webauthnOwnerFromJwk,
  webauthnOwnerToStore,
} from "../services/api/src/wallet/candide.js";

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
assert.match(safe.accountAddress, /^0x[0-9a-fA-F]{40}$/);
assert.equal(
  smartAccountForPasskeyCosigner(passkeyOwner, cosigner).accountAddress,
  safe.accountAddress,
  "passkey/co-signer Safe address must be deterministic",
);
assert.notEqual(
  smartAccountFor(cosigner).accountAddress.toLowerCase(),
  safe.accountAddress.toLowerCase(),
  "2-of-2 passkey/co-signer Safe must not collapse to the legacy single-EOA Safe",
);
const recoverySetup = passkeySafeRecoverySetupTransactions({
  address: safe.accountAddress as `0x${string}`,
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
assert.equal(webauthnOwnerFromJwk({ ...jwk, crv: "P-384" }), null);

const deploymentSources = [
  "services/api/src/server.ts",
  "services/api/src/adapters/monerium-sandbox.ts",
  "services/api/src/wallet/candide.ts",
];
for (const rel of deploymentSources) {
  const source = readFileSync(path.join(ROOT, rel), "utf8");
  assert.ok(!source.includes("deploySmartAccount"), `${rel} must not expose an alternate Safe deployment helper`);
}
const serverSource = readFileSync(path.join(ROOT, "services/api/src/server.ts"), "utf8");
assert.ok(
  serverSource.includes('"/api/users/:id/passkey-safe/deployment"'),
  "the passkey Safe deployment route must remain present",
);

console.log("PASSKEY SAFE PLAN TEST PASSED");
