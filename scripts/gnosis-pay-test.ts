/**
 * Gnosis Pay permissionless adapter — auth + read-only foundation.
 *
 * The integration doc got two details of the real API wrong (checked against
 * the live OpenAPI spec and endpoint). Both fail in a way that looks like a
 * Zold bug:
 *
 *   1. GET /auth/nonce returns text/plain; parsing it as JSON throws.
 *   2. That response sets a `siwe` cookie and the challenge is verified
 *      against it. Without carrying the cookie forward, every signature is
 *      rejected as if the user signed the wrong thing.
 *
 * Also covered: the chain is pinned to Gnosis (100), not derived from the app
 * chain; balances stay strings; a 401 from Gnosis Pay does not become a 401
 * from us (which would log the user out of Zold); no JWT is persisted.
 *
 * The router matrix (second half): a Zold session never ends up connected to
 * a Gnosis Pay profile it did not start and sign for. Start and verify are
 * bound (same account, same message, same cookie, once, within the TTL);
 * the profile must list the wallet that signed; /account never re-records
 * another profile over the connected one; upstream bodies are capped and a
 * stalled one is a 504; the JWT reaches no store, log or other response.
 * One process: the pending sign-ins are this process's, so a second
 * instance or a restart is not modelled (an open deployment decision).
 *
 * Stub Gnosis Pay, no chain, no network.
 *
 * Run: npm run gnosispay:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

const NONCE = "91300995f3381b0b858e3c775e5a8e7d27bfb005d6ff3a88e8d0b842fd804d7a";
const COOKIE_VALUE = "siwe=stub-session-cookie";
const TOKEN = "stub.jwt.token";
const SIGNER = "0x1111111111111111111111111111111111111111";
const GP_SAFE = "0x2222222222222222222222222222222222222222";

let sawCookieOnChallenge: string | undefined;
let nonceCalls = 0;
let unauthorizedNext = false;
/** The profile read answers 200 with a body the route cannot use. */
let nullProfileNext = false;

// ---- router-matrix stub state -------------------------------------------
/** A fresh nonce and cookie per call, as the real endpoint does. */
let freshNonces = false;
const nonceOfCookie = new Map<string, string>();
/** Tokens the stub issued, and whose profile each one reads. */
const profileOfToken = new Map<string, Record<string, unknown>>();
let challengeCalls = 0;
/** The next answer on a path starting with `path` is broken this way. */
let fault: { path: string; kind: "empty" | "malformed" | "oversized" | "hang" | "echo" } | undefined;
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** Signs in, but its profile lists WALLET_B as the sign-in wallet. */
const WALLET_M = "0xcccccccccccccccccccccccccccccccccccccccc";
/** Signs in, but its profile carries no id. */
const WALLET_N = "0xdddddddddddddddddddddddddddddddddddddddd";
const profileOfWallet: Record<string, Record<string, unknown>> = {
  [WALLET_A]: { id: "gp-A", kycStatus: "approved", status: "active", signInWallets: [{ address: WALLET_A }], safeWallets: [{ address: GP_SAFE, chainId: 100 }] },
  [WALLET_B]: { id: "gp-B", kycStatus: "approved", status: "active", signInWallets: [{ address: WALLET_B }] },
  [WALLET_M]: { id: "gp-M", signInWallets: [{ address: WALLET_B }] },
  [WALLET_N]: { signInWallets: [{ address: WALLET_N }] },
};

const stub: Server = createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  };
  if (fault && url.startsWith(fault.path)) {
    const { kind } = fault;
    fault = undefined;
    if (kind === "empty") return send(200, "", "text/plain");
    if (kind === "malformed") return send(200, "{not json", "text/plain");
    if (kind === "oversized") return send(200, "x".repeat(2 * 1024 * 1024), "text/plain");
    if (kind === "echo") return send(400, { message: `rejected ${req.headers.authorization}` });
    // Headers, a first byte, then nothing: only our timeout ends this.
    res.writeHead(200, { "content-type": "application/json" });
    return res.write("[");
  }
  if (url.startsWith("/api/v1/auth/nonce") && freshNonces) {
    nonceCalls++;
    const nonce = randomBytes(16).toString("hex");
    const cookie = `siwe=c${randomBytes(8).toString("hex")}`;
    nonceOfCookie.set(cookie, nonce);
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": `${cookie}; Path=/; HttpOnly` });
    return res.end(nonce);
  }
  if (url.startsWith("/api/v1/auth/challenge") && freshNonces) {
    challengeCalls++;
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const { message = "", signature = "" } = JSON.parse(body || "{}");
      const nonce = nonceOfCookie.get(String(req.headers.cookie ?? ""));
      // Deliberately NOT single-use: what stops a replay must be ours.
      if (!nonce || !String(message).includes(`Nonce: ${nonce}`)) return send(401, { message: "invalid nonce" });
      const signer = String(message).split("\n")[1]?.toLowerCase();
      if (signature !== `signed:${signer}` || !profileOfWallet[signer]) return send(401, { message: "invalid signature" });
      const token = `jwt.${signer.slice(2, 6)}.${randomBytes(12).toString("hex")}`;
      profileOfToken.set(token, profileOfWallet[signer]);
      return send(200, { token });
    });
  }
  const issued = profileOfToken.get(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
  if (issued) {
    if (url.startsWith("/api/v1/user")) return send(200, issued);
    if (url.startsWith("/api/v1/cards")) return send(200, []);
    if (url.startsWith("/api/v1/account-balances")) return send(200, { total: "0", spendable: "0", pending: "0" });
    if (url.startsWith("/api/v1/transactions")) return send(200, []);
  }
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
    if (nullProfileNext) return send(200, null);
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
// Short, so the stalled-body cases finish quickly.
process.env.GNOSIS_PAY_TIMEOUT_MS = "600";

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
  // The User shape lives in store/types.ts; store.ts is the methods over it.
  const src = readFileSync("services/api/src/store/types.ts", "utf8");
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

await check("an internal failure answers 500 with a reference, never the raw error text", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-gnosis-pay-")), "db.json");
  const express = (await import("express")).default;
  const { initStore, store } = await import("../services/api/src/store.js");
  const { createGnosisPayRouter } = await import("../services/api/src/routes/gnosis-pay.js");
  initStore();
  store.addUser({ id: "u_gp", name: "u", country: "DE", kycStatus: "approved", createdAt: new Date().toISOString() } as any);
  const app = express();
  app.use("/api/gnosis-pay", createGnosisPayRouter(() => ({ userId: "u_gp" }) as any));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const quiet = console.error;
  console.error = () => {};
  nullProfileNext = true;
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/gnosis-pay/account`, {
      headers: { "x-gnosis-pay-token": TOKEN },
    });
    const body = (await res.json()) as any;
    assert.equal(res.status, 500);
    assert.equal(body.code, "INTERNAL");
    assert.match(body.ref, /\S/);
    assert.doesNotMatch(body.error, /null|Cannot read|TypeError|properties/i, body.error);
  } finally {
    nullProfileNext = false;
    console.error = quiet;
    server.close();
  }
});


// ===========================================================================
// Router matrix: sessions A and B, the stub issuing a fresh nonce per start.
{
  const express = (await import("express")).default;
  const { store } = await import("../services/api/src/store.js");
  const { SECURITY } = await import("../services/api/src/config.js");
  const { DB_PATH } = await import("../services/api/src/store/db.js");
  const { createGnosisPayRouter } = await import("../services/api/src/routes/gnosis-pay.js");
  const { readFileSync } = await import("node:fs");
  for (const id of ["u_a", "u_b"]) {
    store.addUser({ id, name: id, country: "DE", kycStatus: "approved", createdAt: new Date().toISOString() } as any);
  }
  freshNonces = true;
  const app = express().use(express.json({ limit: SECURITY.jsonBodyLimit }));
  app.use("/api/gnosis-pay", createGnosisPayRouter((req, res) => {
    const userId = req.header("x-user");
    if (!userId) { res.status(401).json({ error: "no session" }); return undefined; }
    return { userId } as any;
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/gnosis-pay`;

  // Everything the API says, in logs and in answers, for the token checks.
  const logged: string[] = [];
  const answers: Array<{ path: string; text: string }> = [];
  const tokens: string[] = [];
  const realLog = console.log, realError = console.error, realWarn = console.warn;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  // The harness's own numbered lines quote answers, and are not the API's logs.
  console.log = (...a: unknown[]) => { const line = a.map(String).join(" "); if (!/^\d+\. /.test(line)) logged.push(line); realLog(...a); };

  const call = async (method: string, path: string, as: string | undefined, opts: { json?: unknown; raw?: string; token?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (as) headers["x-user"] = as;
    if (opts.token) headers["x-gnosis-pay-token"] = opts.token;
    if (opts.json !== undefined || opts.raw !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(base + path, {
      method, headers,
      ...(opts.raw !== undefined ? { body: opts.raw } : opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    });
    const text = await r.text();
    let body: any = {};
    try { body = JSON.parse(text); } catch { /* the parser's own HTML error page */ }
    answers.push({ path, text });
    if (typeof body.token === "string") tokens.push(body.token);
    return { status: r.status, body };
  };
  const start = async (as: string, address: string) => {
    const r = await call("POST", "/siwe/start", as, { json: { address } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { message: r.body.message as string, cookie: r.body.cookie as string, signature: `signed:${address.toLowerCase()}` };
  };
  const verify = (as: string, v: { message: string; cookie: string; signature: string }) =>
    call("POST", "/siwe/verify", as, { json: v });
  const connectedOf = (id: string) => store.findUser(id)?.gnosisPay;
  const disconnect = (id: string) => store.updateUser(id, { gnosisPay: undefined });

  await check("router: a start and verify on one session connects the signer's profile", async () => {
    const r = await verify("u_a", await start("u_a", WALLET_A));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(connectedOf("u_a")?.userId, "gp-A");
    assert.equal(connectedOf("u_a")?.connectedAddress.toLowerCase(), WALLET_A);
    disconnect("u_a");
  });

  await check("router: a sign-in started by session A cannot be finished by session B", async () => {
    const v = await start("u_a", WALLET_A);
    const before = challengeCalls;
    const r = await verify("u_b", v);
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.token, undefined, "B was handed A's Gnosis Pay token");
    assert.equal(connectedOf("u_b"), undefined, "B connected to A's Gnosis Pay profile");
    assert.equal(challengeCalls, before, "refused before Gnosis Pay is asked");
    const again = await verify("u_a", v);
    assert.notEqual(again.status, 200, "a start tried on another account is spent, not handed back");
    assert.equal(connectedOf("u_a"), undefined);
  });

  await check("router: verify with another start's cookie is refused", async () => {
    const v1 = await start("u_a", WALLET_A);
    const v2 = await start("u_a", WALLET_A);
    const r = await verify("u_a", { ...v1, cookie: v2.cookie });
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(connectedOf("u_a"), undefined);
  });

  await check("router: session A cannot finish with a message for signer B on A's nonce", async () => {
    const v = await start("u_a", WALLET_A);
    const lines = v.message.split("\n");
    lines[1] = WALLET_B;
    const r = await verify("u_a", { message: lines.join("\n"), cookie: v.cookie, signature: `signed:${WALLET_B}` });
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.token, undefined);
    assert.equal(connectedOf("u_a"), undefined, "A connected to B's profile");
  });

  await check("router: a profile that does not list the signing wallet is not connected", async () => {
    const r = await verify("u_a", await start("u_a", WALLET_M));
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.token, undefined);
    assert.equal(connectedOf("u_a"), undefined, "A connected to a profile that is not the signer's");
    const r2 = await verify("u_a", await start("u_a", WALLET_N));
    assert.notEqual(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(connectedOf("u_a"), undefined, "A connected to a profile with no id");
  });

  await check("router: a completed sign-in cannot be replayed", async () => {
    const v = await start("u_a", WALLET_A);
    assert.equal((await verify("u_a", v)).status, 200);
    disconnect("u_a");
    const before = challengeCalls;
    const r = await verify("u_a", v);
    assert.notEqual(r.status, 200, "the same message, signature and cookie signed in twice");
    assert.equal(connectedOf("u_a"), undefined);
    assert.equal(challengeCalls, before);
  });

  await check("router: a sign-in past its time is refused", async () => {
    const v = await start("u_a", WALLET_A);
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60_000;
    let r;
    try { r = await verify("u_a", v); } finally { Date.now = realNow; }
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(connectedOf("u_a"), undefined);
  });

  await check("router: /account with another profile's token never overwrites the connection", async () => {
    assert.equal((await verify("u_a", await start("u_a", WALLET_A))).status, 200);
    const mine = structuredClone(connectedOf("u_a"));
    const theirs = await verify("u_b", await start("u_b", WALLET_B));
    assert.equal(theirs.status, 200);
    const r = await call("GET", "/account", "u_a", { token: theirs.body.token });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.reauth, true);
    assert.equal(r.body.user, undefined, "B's profile was served as A's card account");
    assert.deepEqual(connectedOf("u_a"), mine, "A's stored connection was rewritten from B's profile");
  });

  await check("router: /account with no connection records none", async () => {
    const tokenB = tokens[tokens.length - 1];
    disconnect("u_a");
    const r = await call("GET", "/account", "u_a", { token: tokenB });
    assert.notEqual(r.status, 500);
    assert.equal(connectedOf("u_a"), undefined, "a bare token connected a profile without a sign-in");
  });

  await check("router: empty, malformed, wrong-typed and oversized request bodies connect nothing and call nobody", async () => {
    const before = challengeCalls;
    assert.equal((await call("POST", "/siwe/verify", "u_a")).status, 400);
    assert.equal((await call("POST", "/siwe/verify", "u_a", { raw: "{not json" })).status, 400);
    const r = await call("POST", "/siwe/verify", "u_a", { json: { message: { a: 1 }, signature: ["x"], cookie: 7 } });
    assert.ok(r.status >= 400 && r.status < 500, `${r.status}`);
    const big = "x".repeat(1024 * 1024); // past the parser's limit (64kb by default)
    assert.equal((await call("POST", "/siwe/verify", "u_a", { json: { message: big, signature: "s", cookie: "c" } })).status, 413);
    assert.equal((await call("POST", "/siwe/start", "u_a", { raw: "" })).status, 400);
    assert.equal(challengeCalls, before);
    assert.equal(connectedOf("u_a"), undefined);
  });

  const upstream = async (path: string, kind: NonNullable<typeof fault>["kind"], run: () => Promise<{ status: number; body: any }>) => {
    fault = { path, kind };
    const t0 = Date.now();
    const r = await run();
    fault = undefined;
    return { ...r, ms: Date.now() - t0 };
  };

  await check("router: an empty, oversized or stalled nonce answer starts nothing", async () => {
    for (const kind of ["empty", "oversized"] as const) {
      const r = await upstream("/api/v1/auth/nonce", kind, () => call("POST", "/siwe/start", "u_a", { json: { address: WALLET_A } }));
      assert.equal(r.status, 502, `${kind}: ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.equal(r.body.message, undefined, `${kind}: a sign-in was started on a ${kind} nonce`);
    }
    const r = await upstream("/api/v1/auth/nonce", "hang", () => call("POST", "/siwe/start", "u_a", { json: { address: WALLET_A } }));
    assert.equal(r.status, 504, JSON.stringify(r.body));
    assert.ok(r.ms < 5_000, `bounded by the timeout, took ${r.ms}ms`);
  });

  await check("router: an empty, malformed, oversized or stalled sign-in answer connects nothing", async () => {
    disconnect("u_a");
    for (const kind of ["empty", "malformed", "oversized", "hang"] as const) {
      const v = await start("u_a", WALLET_A);
      const r = await upstream("/api/v1/auth/challenge", kind, () => verify("u_a", v));
      assert.equal(r.status, kind === "hang" ? 504 : 502, `${kind}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.token, undefined);
      assert.equal(connectedOf("u_a"), undefined, kind);
    }
  });

  await check("router: an oversized or stalled profile answer is a 502/504, never a 500", async () => {
    assert.equal((await verify("u_a", await start("u_a", WALLET_A))).status, 200);
    const token = tokens[tokens.length - 1];
    const big = await upstream("/api/v1/user", "oversized", () => call("GET", "/account", "u_a", { token }));
    assert.equal(big.status, 502, JSON.stringify(big.body));
    const hang = await upstream("/api/v1/user", "hang", () => call("GET", "/account", "u_a", { token }));
    assert.equal(hang.status, 504, JSON.stringify(hang.body));
  });

  await check("router: a Gnosis Pay error quoting the token does not carry it back", async () => {
    const token = tokens[tokens.length - 1];
    const r = await upstream("/api/v1/transactions", "echo", () => call("GET", "/transactions", "u_a", { token }));
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.body).includes(token), JSON.stringify(r.body));
  });

  await check("router: no Gnosis Pay token in the store, the logs or any answer but its own sign-in", async () => {
    assert.ok(tokens.length >= 3, "the matrix issued tokens");
    const stored = JSON.stringify(store.findUser("u_a")) + JSON.stringify(store.findUser("u_b")) + readFileSync(DB_PATH, "utf8");
    const log = logged.join("\n");
    for (const token of tokens) {
      assert.ok(!stored.includes(token), "a token is in the store");
      assert.ok(!log.includes(token), "a token is in the logs");
      const where = answers.filter((a) => a.text.includes(token));
      assert.ok(where.every((a) => a.path === "/siwe/verify"), `a token in answers to ${where.map((a) => a.path)}`);
      assert.ok(where.length <= 1, "a token was answered twice");
    }
  });

  console.log = realLog; console.error = realError; console.warn = realWarn;
  freshNonces = false;
  server.closeAllConnections();
  server.close();
}

assert.ok(nonceCalls >= 3, "expected the nonce endpoint to be exercised");
stub.closeAllConnections();
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
