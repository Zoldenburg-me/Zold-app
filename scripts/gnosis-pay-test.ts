/**
 * Gnosis Pay permissionless adapter — auth + read-only foundation.
 *
 * WHAT THESE EXIST TO CATCH. The integration doc transcribed two details of
 * the real API wrongly, and both are silently fatal in a way that reads as our
 * bug rather than theirs:
 *
 *   1. GET /auth/nonce returns text/plain. Parsing it as JSON throws on a
 *      response that was completely fine.
 *   2. That response sets a `siwe` cookie and the challenge is verified
 *      against it. Fetch the nonce server-side without carrying the cookie
 *      forward and every signature comes back rejected, as if the user had
 *      signed the wrong thing.
 *
 * Both were found by reading the live OpenAPI spec and calling the endpoint,
 * and both are asserted here so a refactor cannot quietly reintroduce them.
 *
 * Also covered: the chain is pinned to Gnosis (100) rather than derived from
 * the app chain, balances stay STRINGS, a 401 from Gnosis Pay does not become
 * a 401 from us (which would log the user out of Zold), and no JWT is ever
 * persisted.
 *
 * Stub Gnosis Pay, no chain, no network.
 *
 * Run: npm run gnosispay:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

const NONCE = "91300995f3381b0b858e3c775e5a8e7d27bfb005d6ff3a88e8d0b842fd804d7a";
const COOKIE_VALUE = "siwe=stub-session-cookie";
const TOKEN = "stub.jwt.token";
const SIGNER = "0x1111111111111111111111111111111111111111";
const GP_SAFE = "0x2222222222222222222222222222222222222222";

let sawCookieOnChallenge: string | undefined;
let nonceCalls = 0;
let unauthorizedNext = false;

const stub: Server = createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  };
  if (url.startsWith("/api/v1/auth/nonce")) {
    nonceCalls++;
    // text/plain + set-cookie, exactly as the real endpoint answers.
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": `${COOKIE_VALUE}; Path=/; HttpOnly` });
    return res.end(NONCE);
  }
  if (url.startsWith("/api/v1/auth/challenge")) {
    sawCookieOnChallenge = req.headers.cookie;
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      if (!req.headers.cookie?.includes("siwe=")) {
        return send(401, { message: "invalid nonce" });
      }
      if (!parsed.message || !parsed.signature) return send(400, { message: "bad request" });
      return send(200, { token: TOKEN });
    });
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}` || unauthorizedNext) return send(401, { message: "unauthorized" });
  if (url.startsWith("/api/v1/user")) {
    return send(200, {
      id: "gp-user-1", email: "u@example.com", kycStatus: "approved", status: "active",
      isPhoneValidated: true, isSourceOfFundsAnswered: true,
      signInWallets: [{ address: SIGNER }],
      safeWallets: [{ address: GP_SAFE, chainId: 100 }],
    });
  }
  if (url.startsWith("/api/v1/cards")) {
    return send(200, [{ id: "card-1", lastFourDigits: "4242", virtual: true, statusName: "Active" }]);
  }
  if (url.startsWith("/api/v1/account-balances")) {
    // Minor-unit decimal STRINGS, per their documented ^[0-9]+$ format.
    return send(200, { total: "12345", spendable: "10000", pending: "2345" });
  }
  if (url.startsWith("/api/v1/transactions")) return send(200, [{ opaque: true }]);
  return send(404, { message: "not found" });
});

await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
const port = (stub.address() as any).port;
process.env.GNOSIS_PAY_BASE_URL = `http://127.0.0.1:${port}`;

const gp = await import("../services/api/src/adapters/gnosis-pay.js");
const { GNOSIS_PAY } = await import("../services/api/src/config.js");

let n = 0;
const failures: string[] = [];
const check = async (label: string, fn: () => unknown | Promise<unknown>) => {
  try {
    await fn();
    console.log(`${++n}. ${label}`);
  } catch (err: any) {
    failures.push(`${label}: ${err?.message ?? err}`);
    console.log(`${++n}. FAILED — ${label}: ${err?.message ?? err}`);
  }
};

await check("the nonce is read as text/plain, not JSON", async () => {
  const { nonce } = await gp.getNonce();
  assert.equal(nonce, NONCE, "a text/plain nonce must survive intact");
});

await check("the nonce carries back the cookie the challenge is bound to", async () => {
  const { cookie } = await gp.getNonce();
  assert.ok(cookie.includes("siwe="), "the siwe cookie was dropped");
  assert.ok(!cookie.includes("HttpOnly"), "cookie attributes must be stripped, only name=value is sent");
});

await check("a challenge WITHOUT the cookie is rejected — the trap this guards", async () => {
  await assert.rejects(
    () => gp.verifySiwe("msg", "0xsig", ""),
    /sign-in failed|invalid nonce/i,
    "sending no cookie must fail loudly, not appear to be a bad signature",
  );
});

await check("a full SIWE round trip returns a token", async () => {
  const { nonce, cookie } = await gp.getNonce();
  const message = gp.buildSiweMessage({
    address: SIGNER, nonce, domain: "app.zold.test", uri: "https://app.zold.test",
  });
  const { token } = await gp.verifySiwe(message, "0xsignature", cookie);
  assert.equal(token, TOKEN);
  assert.ok(sawCookieOnChallenge?.includes("siwe="), "the challenge did not carry the cookie");
});

await check("the SIWE message names GNOSIS chain 100, not the app chain", async () => {
  const msg = gp.buildSiweMessage({
    address: SIGNER, nonce: NONCE, domain: "app.zold.test", uri: "https://app.zold.test",
  });
  assert.equal(GNOSIS_PAY.siweChainId, 100);
  assert.match(msg, /^Chain ID: 100$/m, "a message naming our chain is rejected by Gnosis Pay");
  assert.equal(msg.split("\n")[1], SIGNER, "line 2 of a SIWE message must be the address");
});

await check("balances stay STRINGS of minor units", async () => {
  const b = await gp.getAccountBalances(TOKEN);
  assert.equal(typeof b.total, "string");
  assert.equal(b.spendable, "10000");
  assert.ok(!Number.isFinite(b as any), "a balance must never be coerced to a number");
});

await check("the Gnosis Pay Safe is read from safeWallets for chain 100", async () => {
  const u = await gp.getUser(TOKEN);
  assert.equal(gp.safeAddressOf(u), GP_SAFE);
});

await check("a Safe on another chain is NOT reported as the Gnosis Pay Safe", () => {
  assert.equal(gp.safeAddressOf({ safeWallets: [{ address: GP_SAFE, chainId: 8453 }] }), undefined);
});

await check("cards and transactions read through", async () => {
  assert.equal((await gp.listCards(TOKEN))[0]?.lastFourDigits, "4242");
  assert.equal((await gp.listTransactions(TOKEN)).length, 1);
});

await check("an expired Gnosis Pay session surfaces as 401 from THEM, with their text", async () => {
  unauthorizedNext = true;
  await assert.rejects(
    () => gp.getUser(TOKEN),
    (err: any) => err instanceof gp.GnosisPayError && err.status === 401,
    "the adapter must preserve their status so the router can avoid logging the user out of Zold",
  );
  unauthorizedNext = false;
});

await check("no JWT is persisted anywhere in the user record", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("services/api/src/store.ts", "utf8");
  const block = src.slice(src.indexOf("gnosisPay?: {"), src.indexOf("paymentPage?: {"));
  assert.ok(block.length > 0, "gnosisPay state not found in the store");
  assert.ok(!/jwt|token/i.test(block), "the stored Gnosis Pay state must not carry a credential");
});

await check("the router maps a Gnosis Pay 401 to 409, not 401", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("services/api/src/routes/gnosis-pay.ts", "utf8");
  assert.match(src, /err\.status === 401 \|\| err\.status === 403 \? 409/,
    "a 401 passed through would log the user out of Zold for a third party's expiry");
});

await check("permissionless provenance is attached, never implied away", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("services/api/src/routes/gnosis-pay.ts", "utf8");
  assert.match(src, /no webhooks/i, "responses must state that figures are snapshots");
  assert.match(src, /Gnosis Pay issues and operates this card/i, "must not imply Zold issues the card");
});

assert.ok(nonceCalls >= 3, "expected the nonce endpoint to be exercised");
stub.close();

console.log("");
if (failures.length) {
  console.error(`${failures.length} check(s) FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`gnosis-pay: ${n}/${n} checks passed`);
console.log("");
console.log("NOT PROVEN HERE: no real Gnosis Pay account has been connected. The stub answers the");
console.log("shapes their live OpenAPI spec declares; a real SIWE round trip needs a funded wallet");
console.log("and their onboarding. Signup/terms/KYC/Safe-deploy/card-creation are PR 2-4 and absent.");
