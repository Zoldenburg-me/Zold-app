/**
 * Monerium webhook regression test.
 *
 * The receiver reads only an order id from the body and re-reads that order
 * from Monerium, so a forged payload buys nothing — crediting whatever the
 * body states would be an unauthenticated mint for anyone who could reach
 * the port.
 *
 * This runs the API in sandbox mode against a stub Monerium server (so no
 * credentials are needed) and asserts:
 *   1. a forged deposit for an arbitrary address/amount credits nothing
 *   2. an id Monerium doesn't know is refused
 *   3. a genuine order id credits exactly what MONERIUM says, not the body
 *   4. replaying it credits nothing further
 *   5. with MONERIUM_WEBHOOK_SECRET set, Monerium's documented
 *      webhook-id/timestamp/signature scheme is enforced
 *   6. an order another caller is recording, or a token lookup Monerium
 *      cannot answer (5xx, 429, a body that is not a token list), asks to be
 *      retried rather than spending the delivery
 *   7. the poller and a delivery for the same order credit it once
 *
 * Run: npm run webhook:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newDevice, registerDevice } from "./device.js";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
const STUB_PORT = Number(process.env.TRANSF_STUB_PORT ?? 8547);
const SECRET = "whsec_" + Buffer.from("test-webhook-secret-32-byte-key!!").toString("base64");
const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);

let token = "";
const children: ChildProcess[] = [];

/* ---- stub Monerium: only what the adapter actually calls ---- */
const orders = new Map<string, any>();
/** Order ids the stub answers with 503 — Monerium briefly unreachable, as
 *  distinct from a 404 that says the order genuinely does not exist. */
const unavailable = new Set<string>();
/** While set, /tokens answers this instead of its usual 404 ("no EURe on this
 *  chain"): an outage or a body that is not a token list. */
let tokensOutage: { code: number; body: unknown } | null = null;
let tokensRequests = 0;
/** Order ids the poller's list shows. Empty except where a test arms it. */
const listed = new Set<string>();
let listServed = false;
/**
 * While set, /tokens is answered only on `release()`. mirrorOrder asks /tokens
 * between its processed check and its mark, so this parks the first caller
 * inside that window while a test sends the second: the interleaving that
 * would credit an order twice without the claim.
 */
type Hold = { tokensHits: number; release: () => void; released: Promise<void> };
let hold: Hold | null = null;
function armHold(): Hold {
  let release = () => {};
  const released = new Promise<void>((r) => (release = r));
  hold = { tokensHits: 0, release, released };
  return hold;
}
function disarmHold() {
  hold?.release();
  hold = null;
}
const stub = createServer((req, res) => {
  const send = (code: number, body: any) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  if (url.startsWith("/auth/token")) return send(200, { access_token: "stub", expires_in: 3600 });
  if (url.startsWith("/auth/context")) return send(200, { userId: "stub-user" });
  if (url.startsWith("/profiles")) return send(200, { profiles: [{ id: "stub-profile" }] });
  if (url.startsWith("/addresses")) return send(200, {});
  if (url.startsWith("/ibans")) return send(200, { ibans: [] });
  const one = url.match(/^\/orders\/([^?]+)/);
  if (one) {
    const wanted = decodeURIComponent(one[1]);
    if (unavailable.has(wanted)) return send(503, { error: "service unavailable" });
    const o = orders.get(wanted);
    return o ? send(200, o) : send(404, { error: "no such order" });
  }
  if (url.startsWith("/tokens")) {
    tokensRequests++;
    const answer = () =>
      tokensOutage ? send(tokensOutage.code, tokensOutage.body) : send(404, { error: "no EURe on this chain" });
    if (!hold) return answer();
    hold.tokensHits++;
    return void hold.released.then(answer);
  }
  // The list is the poller's view. The poller ticks once at startup whatever
  // MONERIUM_POLL_MS says, so an order listed by default could be recorded by
  // that tick instead of by the delivery under test, which would then rightly
  // answer `duplicate`. Only the poller test lists an order.
  if (url.startsWith("/orders")) {
    listServed = true;
    return send(200, { orders: [...listed].map((id) => orders.get(id)).filter(Boolean) });
  }
  send(404, { error: "unhandled" });
});

async function api(pathname: string, body?: any, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (body) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(API + pathname, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers: h,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !("__raw" in h)) throw new Error(`${pathname}: ${data.error ?? res.statusText}`);
  return data;
}

async function post(pathname: string, body: any, headers: Record<string, string> = {}) {
  const res = await fetch(API + pathname, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function moneriumSignature(webhookId: string, timestamp: string, body: any, secret = SECRET) {
  const raw = JSON.stringify(body);
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = `${webhookId}.${timestamp}.${raw}`;
  return `v1,${createHmac("sha256", key).update(signed).digest("base64")}`;
}

function signedHeaders(webhookId: string, body: any, secret = SECRET) {
  const timestamp = new Date().toISOString();
  return {
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": moneriumSignature(webhookId, timestamp, body, secret),
  };
}

function bg(cmd: string, args: string[], env: Record<string, string>) {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: { ...process.env, ...env } });
  children.push(c);
  return c;
}

/** Settle `p`, or fail naming what never answered instead of hanging the suite. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Poll `ok` until it holds. A throw counts as "not yet": the API may be mid-restart. */
async function until(ok: () => boolean | Promise<boolean>, ms: number, what: string) {
  let last: unknown;
  for (const s = Date.now(); Date.now() - s < ms; ) {
    try {
      if (await ok()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message ?? last})` : ""}`);
}

async function startApi(env: Record<string, string>) {
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], env);
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the API did not answer /api/health on :${API_PORT} within 30s`);
}

/**
 * Wait for the old server to actually exit and release the port before
 * rebinding it. A fixed 1.2s sleep was a guess, and under a full suite run
 * — where dozens of chains and servers are starting and stopping — it was
 * routinely too short: the replacement failed to bind, the health poll timed
 * out 30s later, and the failure looked like a broken product rather than a
 * race in the test.
 */
async function restartApi(env: Record<string, string>) {
  const dying = children.at(-1)!;
  await new Promise<void>((resolve) => {
    if (dying.exitCode !== null || dying.signalCode !== null) return resolve();
    dying.once("exit", () => resolve());
    dying.kill();
    setTimeout(() => resolve(), 10_000).unref(); // never hang the suite
  });
  // The process is gone; now wait for the socket to be free.
  for (const s = Date.now(); Date.now() - s < 15_000; ) {
    const stillUp = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(500) })
      .then(() => true)
      .catch(() => false);
    if (!stillUp) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await startApi(env);
}

const SIGNED_ENV = {
  MONERIUM_CLIENT_ID: "stub",
  MONERIUM_CLIENT_SECRET: "stub",
  MONERIUM_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
  MONERIUM_POLL_MS: "3600000",
  MONERIUM_WEBHOOK_SECRET: SECRET,
  MG_ANCHOR_DOMAIN: "",
};

let pass = 0;
const t = async (label: string, fn: () => Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

// Fail fast if another stack holds our ports — otherwise the spawns fail
// silently (stdio: "ignore") and the test talks to a stale server, which
// looks like a product bug instead of a leaked process.
for (const [name, url] of [
  [`api :${API_PORT}`, `${API}/api/health`],
  [`chain :${RPC_PORT}`, RPC_URL],
  [`stub :${STUB_PORT}`, `http://127.0.0.1:${STUB_PORT}/orders`],
] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) {
    console.error(`${name} is already in use — stop it (or a leftover test) and re-run.`);
    process.exit(1);
  }
}

try {
  await new Promise<void>((r) => stub.listen(STUB_PORT, r));

  console.log("1/3 chain + deploy…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT], {});
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try {
      const r = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(
    spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit" }).status,
    0,
    "deploy failed",
  );

  console.log("2/3 API in sandbox mode against the stub…");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  await startApi({
    MONERIUM_CLIENT_ID: "stub",
    MONERIUM_CLIENT_SECRET: "stub",
    MONERIUM_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    MONERIUM_CHAIN: "sepolia", // the stub issues on sepolia; the chain filter must see the same name
    MONERIUM_POLL_MS: "3600000", // no second tick; the startup tick sees an empty list
    MONERIUM_WEBHOOK_SECRET: "",
    MG_ANCHOR_DOMAIN: "",
  });

  const user = await api("/api/users", { name: "Webhook Target", email: "webhook@example.com", country: "DE" });
  token = user.sessionToken;
  await registerDevice(api, user.id, newDevice());
  const balance = async () => (await api(`/api/users/${user.id}`)).balanceEur;
  assert.equal(await balance(), 0);

  console.log("3/3 asserting the receiver ignores the body…");

  await t("a forged deposit for an arbitrary amount credits nothing", async () => {
    const r = await post("/api/webhooks/monerium", {
      data: {
        id: "forged-1",
        kind: "issue",
        state: "processed",
        meta: { state: "processed" },
        address: user.address,
        amount: "1000000",
      },
    });
    assert.equal(r.data.handled, false, "forged order must not be handled");
    assert.equal(await balance(), 0, "forged webhook minted balance");
  });

  await t("an order id Monerium does not know is refused", async () => {
    const r = await post("/api/webhooks/monerium", { data: { id: "no-such-order" } });
    assert.equal(r.data.handled, false);
    assert.equal(await balance(), 0);
  });

  await t("a genuine order credits Monerium's amount, not the body's", async () => {
    orders.set("real-1", {
      id: "real-1",
      kind: "issue",
      state: "processed",
      meta: { state: "processed" },
      address: user.address,
      amount: "40",
      currency: "eur",
      chain: "sepolia",
    });
    // The body lies about the amount; the receiver must use Monerium's 40.
    const r = await post("/api/webhooks/monerium", {
      data: { id: "real-1", amount: "999999", address: user.address },
    });
    assert.equal(r.data.handled, true);
    assert.equal(await balance(), 40, "credited the body's amount instead of Monerium's");
  });

  await t("replaying the same order credits nothing further", async () => {
    const r = await post("/api/webhooks/monerium", { data: { id: "real-1" } });
    assert.equal(r.data.handled, false);
    assert.equal(await balance(), 40);
  });

  console.log("      restarting API with a webhook secret…");
  await restartApi(SIGNED_ENV);

  orders.set("real-2", {
    id: "real-2",
    kind: "issue",
    state: "processed",
    meta: { state: "processed" },
    address: user.address,
    amount: "10",
    currency: "eur",
    chain: "sepolia",
  });

  await t("an unsigned delivery is rejected when a secret is set", async () => {
    const r = await post("/api/webhooks/monerium", { data: { id: "real-2" } });
    assert.equal(r.status, 401);
    assert.equal(await balance(), 40);
  });

  await t("a wrongly-signed delivery is rejected", async () => {
    const body = { data: { id: "real-2" } };
    const r = await post("/api/webhooks/monerium", body, signedHeaders("evt-real-2-bad", body, "whsec_" + Buffer.from("wrong-secret-32-byte-key!!!!").toString("base64")));
    assert.equal(r.status, 401);
    assert.equal(await balance(), 40);
  });

  await t("a correctly-signed delivery is accepted", async () => {
    const body = { data: { id: "real-2" } };
    const r = await post("/api/webhooks/monerium", body, signedHeaders("evt-real-2", body));
    assert.equal(r.status, 200);
    assert.equal(r.data.handled, true);
    assert.equal(await balance(), 50);
  });

  await t("a retried webhook delivery id is ignored", async () => {
    orders.set("real-3", {
      id: "real-3",
      kind: "issue",
      state: "processed",
      meta: { state: "processed" },
      address: user.address,
      amount: "20",
      currency: "eur",
      chain: "sepolia",
    });
    const body = { data: { id: "real-3" } };
    const headers = signedHeaders("evt-real-2", body);
    const r = await post("/api/webhooks/monerium", body, headers);
    assert.equal(r.status, 200);
    assert.equal(r.data.duplicate, true);
    assert.equal(await balance(), 50);
  });


  await t("a transient Monerium outage does not consume the delivery id", async () => {
    // First delivery arrives while Monerium is unreachable for this order.
    unavailable.add("real-9");
    const body = { data: { id: "real-9" } };
    const first = await post("/api/webhooks/monerium", body, signedHeaders("evt-real-9", body));
    assert.equal(first.status, 503, "an unresolved delivery must ask for a retry");
    assert.equal(first.data.outcome, "unavailable");

    // Monerium recovers and retries the SAME delivery id, as its retry policy
    // does. A 503 must not consume the delivery id, or the retry is dropped as
    // a duplicate and the deposit never lands by this path.
    unavailable.delete("real-9");
    orders.set("real-9", {
      id: "real-9", kind: "issue", state: "processed", meta: { state: "processed" },
      address: user.address, amount: "33", currency: "eur", chain: "sepolia",
    });
    const retry = await post("/api/webhooks/monerium", body, signedHeaders("evt-real-9", body));
    assert.equal(retry.status, 200);
    assert.equal(retry.data.handled, true, "the retry must be accepted, not treated as a duplicate");
    assert.equal(await balance(), 83, "€33 should have been credited on the retry");
  });

  await t("a delivery for an order another delivery is recording asks to be retried", async () => {
    // Monerium sends one delivery per order event, each with its own id, so
    // the delivery-id dedupe cannot catch this; only the order-id claim can.
    orders.set("real-race", {
      id: "real-race", kind: "issue", state: "processed", meta: { state: "processed" },
      address: user.address, amount: "7", currency: "eur", chain: "sepolia",
    });
    const body = { data: { id: "real-race" } };
    const h = armHold();
    try {
      const first = post("/api/webhooks/monerium", body, signedHeaders("evt-race-a", body));
      // Awaited below; this only keeps an early failure from also surfacing
      // as an unhandled rejection.
      first.catch(() => {});
      await until(() => h.tokensHits >= 1, 10_000, "the first delivery to reach /tokens");
      // The first delivery is parked between its check and its mark.
      const second = await within(
        post("/api/webhooks/monerium", body, signedHeaders("evt-race-b", body)),
        10_000,
        "a second delivery while the first held the order",
      );
      assert.equal(second.status, 503, "an order still being recorded is not settled");
      assert.equal(second.data.outcome, "unavailable");
      assert.equal(h.tokensHits, 1, "the second delivery must not reach the window");
      h.release();
      const a = await within(first, 10_000, "the first delivery");
      assert.equal(a.status, 200);
      assert.equal(a.data.outcome, "recorded");
    } finally {
      disarmHold();
    }
    // Monerium retries the 503'd delivery under the same id; now it is settled.
    const retry = await post("/api/webhooks/monerium", body, signedHeaders("evt-race-b", body));
    assert.equal(retry.status, 200);
    assert.equal(retry.data.outcome, "duplicate");
    assert.equal(await balance(), 90, "€7 must be credited once, not twice");
  });

  const outages = [
    { label: "a 503", order: "real-tok-503", amount: 4, code: 503, body: { error: "service unavailable" } },
    { label: "a 429", order: "real-tok-429", amount: 2, code: 429, body: { error: "too many requests" } },
    { label: "a 200 that is not a token list", order: "real-tok-obj", amount: 1, code: 200, body: { error: "maintenance" } },
  ];
  let expected = 90;
  for (const o of outages) {
    await t(`a token lookup answered with ${o.label} does not consume the delivery id`, async () => {
      orders.set(o.order, {
        id: o.order, kind: "issue", state: "processed", meta: { state: "processed" },
        address: user.address, amount: String(o.amount), currency: "eur", chain: "sepolia",
      });
      const body = { data: { id: o.order } };
      const headers = () => signedHeaders(`evt-${o.order}`, body);
      tokensOutage = { code: o.code, body: o.body };
      try {
        const first = await post("/api/webhooks/monerium", body, headers());
        assert.equal(first.status, 503, `${o.label} is not "no EURe on this chain"`);
        assert.equal(first.data.outcome, "unavailable");
        // Inside the cooldown the API does not ask Monerium again.
        const asked = tokensRequests;
        const again = await post("/api/webhooks/monerium", body, headers());
        assert.equal(again.status, 503);
        assert.equal(tokensRequests, asked, "a retry inside the outage cooldown must not re-ask /tokens");
        assert.equal(await balance(), expected);
      } finally {
        tokensOutage = null;
      }
      // Monerium retries the same delivery id until the cooldown has passed.
      let retry: Awaited<ReturnType<typeof post>> | undefined;
      await until(async () => {
        retry = await post("/api/webhooks/monerium", body, headers());
        return retry.status !== 503;
      }, 10_000, `the ${o.label} retry to settle`);
      assert.equal(retry!.status, 200);
      assert.equal(retry!.data.outcome, "recorded");
      expected += o.amount;
      assert.equal(await balance(), expected);
    });
  }

  await t("a definitively unknown order still consumes its delivery id", async () => {
    // A 404 from Monerium is a settled answer, not an outage — retrying it
    // forever would be pointless, so 200 tells the sender to stop.
    const body = { data: { id: "nope-404" } };
    const r = await post("/api/webhooks/monerium", body, signedHeaders("evt-404", body));
    assert.equal(r.status, 200);
    assert.equal(r.data.outcome, "ignored");
  });

  await t("a stale signed delivery is refused even with a valid signature", async () => {
    const body = { data: { id: "real-1" } };
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const r = await post("/api/webhooks/monerium", body, {
      "webhook-id": "evt-stale",
      "webhook-timestamp": old,
      "webhook-signature": moneriumSignature("evt-stale", old, body),
    });
    assert.equal(r.status, 401, "an hour-old delivery is outside the replay window");
  });

  console.log("      restarting API with an order listed for the poller…");
  await t("the poller and a delivery for the same order credit it once", async () => {
    orders.set("real-poll", {
      id: "real-poll", kind: "issue", state: "processed", meta: { state: "processed" },
      address: user.address, amount: "5", currency: "eur", chain: "sepolia",
    });
    listed.add("real-poll");
    listServed = false;
    const h = armHold();
    const body = { data: { id: "real-poll" } };
    try {
      // The startup tick lists the order, claims it and parks at /tokens.
      await restartApi(SIGNED_ENV);
      await until(() => listServed && h.tokensHits >= 1, 20_000, "the poller to reach /tokens");
      const r = await within(
        post("/api/webhooks/monerium", body, signedHeaders("evt-poll", body)),
        10_000,
        "a delivery while the poller held the order",
      );
      assert.equal(r.status, 503, "the poller is still recording this order");
      assert.equal(r.data.outcome, "unavailable");
      h.release();
      await until(async () => (await balance()) === 102, 15_000, "the poller to credit €5");
    } finally {
      disarmHold();
      listed.delete("real-poll");
    }
    const retry = await post("/api/webhooks/monerium", body, signedHeaders("evt-poll", body));
    assert.equal(retry.status, 200);
    assert.equal(retry.data.outcome, "duplicate");
    assert.equal(await balance(), 102, "€5 must be credited once, not twice");
  });

  console.log(`\nWEBHOOK TEST PASSED — ${pass}/${pass}: body is untrusted, secret gate enforced`);
} finally {
  for (const c of children) c.kill();
  stub.close();
}
