import assert from "node:assert/strict";
import { smartAccountFor, smartAccountForPasskeyCosigner, webauthnOwnerFromJwk } from "../services/api/src/wallet/candide.js";

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
assert.equal(webauthnOwnerFromJwk({ ...jwk, crv: "P-384" }), null);

console.log("PASSKEY SAFE PLAN TEST PASSED");
