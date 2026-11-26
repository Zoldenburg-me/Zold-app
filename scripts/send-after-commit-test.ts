/**
 * Responses sent inside a `store.tx` (http/send-after-commit.ts), at the
 * Express level, and the run-time refusal of partner and chain I/O inside
 * one (store/backend.ts refuseInTx).
 *
 * - A send in a transaction that then throws: a 500, never the 2xx, and
 *   none of the headers or the status set inside it.
 * - A second send in one transaction fails at once.
 * - An after-commit hook that throws is logged; the rest run and the
 *   committed transaction still resolves.
 * - Postgres (PGlite) whose COMMIT fails: the held 2xx never goes out.
 * - JSON whose file write fails: nothing is answered, and the process exits 1.
 * - `fetch` and `writeAndWait` refuse inside a transaction, not outside.
 *
 * Offline.  npm run send-after-commit:test
 */
// Must be first: pins chain, keys and a throwaway database.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import express from "express";

const tmp = mkdtempSync(path.join(tmpdir(), "zold-send-commit-"));
process.env.TRANSF_DB_PATH = path.join(tmp, "db.json");

const { initStore, store } = await import("../services/api/src/store.js");
const { deferToCommit } = await import("../services/api/src/store/backend.js");
const { sendAfterCommit } = await import("../services/api/src/http/send-after-commit.js");
const { createPgStore } = await import("../services/api/src/store/pg/backend.js");
const { migrate } = await import("../services/api/src/store/pg/migrate.js");
const { pgliteDatabase } = await import("../services/api/src/store/pg/sql.js");
type StoreBackend = import("../services/api/src/store/backend.js").StoreBackend;

await initStore();
const now = new Date().toISOString();
await store.addOrganisation({ id: "org_sc", type: "business", name: "Before", createdAt: now, updatedAt: now } as any, false);

/** An app over `s` with the real middleware and a 500 error handler. */
function app(s: StoreBackend) {
  const a = express().use(sendAfterCommit);
  a.post("/answer-then-throw", async (_req, res, next) => {
    res.setHeader("X-Before", "kept");
    await s
      .tx(async (t) => {
        await t.updateOrganisation("org_sc", { name: "Thrown" });
        res.cookie("zold_session", "minted-in-a-dropped-tx");
        res.location("/somewhere");
        res.setHeader("X-Before", "changed-inside");
        res.status(201).json({ ok: true });
        throw new Error("after the answer");
      })
      .catch(next);
  });
  a.post("/nested-then-throw", async (_req, res, next) => {
    res.setHeader("X-Before", "kept");
    await s
      .tx(async () => {
        await s.tx(async () => {
          res.setHeader("X-Before", "inner");
        });
        res.setHeader("X-Before", "outer");
        res.json({ ok: true });
        throw new Error("after the answer");
      })
      .catch(next);
  });
  a.post("/twice", async (_req, res, next) => {
    await s
      .tx(async () => {
        res.json({ first: true });
        res.json({ second: true });
      })
      .catch(next);
  });
  a.post("/commit", async (_req, res, next) => {
    await s
      .tx(async (t) => {
        await t.updateOrganisation("org_sc", { name: "Committed" });
        res.cookie("zold_session", "minted");
        res.status(201).json({ ok: true });
      })
      .catch(next);
  });
  a.use(((_err, _req, res, _next) => void res.status(500).json({ error: "internal" })) as express.ErrorRequestHandler);
  return a;
}

async function serve(a: express.Express) {
  const server = a.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

// ── JSON ──────────────────────────────────────────────────────────────────
{
  const { url, close } = await serve(app(store));
  try {
    const r = await fetch(`${url}/answer-then-throw`, { method: "POST" });
    assert.equal(r.status, 500, "the held 201 is dropped; the error handler answers");
    assert.deepEqual(await r.json(), { error: "internal" });
    assert.equal(r.headers.get("set-cookie"), null, "a cookie set inside the dropped transaction does not go out");
    assert.equal(r.headers.get("location"), null);
    assert.equal(r.headers.get("x-before"), "kept", "a header set before the transaction is restored, not removed");
    console.log("ok - JSON: a send then a throw answers 500, without the headers set inside the transaction");

    const nested = await fetch(`${url}/nested-then-throw`, { method: "POST" });
    assert.equal(nested.status, 500);
    assert.equal(nested.headers.get("x-before"), "kept", "undone last first, through a nested transaction");

    const twice = await fetch(`${url}/twice`, { method: "POST" });
    assert.equal(twice.status, 500, "a second send inside one transaction fails it at once");
    assert.deepEqual(await twice.json(), { error: "internal" });
    console.log("ok - JSON: a second send in one transaction fails at once");

    const ok = await fetch(`${url}/commit`, { method: "POST" });
    assert.equal(ok.status, 201);
    assert.match(ok.headers.get("set-cookie") ?? "", /zold_session=minted/);
    assert.equal((await store.findOrganisation("org_sc"))?.name, "Committed");
  } finally {
    close();
  }

  // An after-commit hook that throws: logged, the rest still run, and the
  // transaction's caller sees the commit it made.
  const ran: string[] = [];
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    const out = await store.tx(async (t) => {
      await t.updateOrganisation("org_sc", { name: "Hooks" });
      deferToCommit(() => ran.push("first"));
      deferToCommit(() => {
        throw new Error("a hook that fails");
      });
      deferToCommit(() => ran.push("third"));
      return "committed";
    });
    assert.equal(out, "committed");
  } finally {
    console.error = error;
  }
  assert.deepEqual(ran, ["first", "third"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /after-commit hook failed/);
  console.log("ok - an after-commit hook that throws is logged; the others run and the commit resolves");
}

// ── Postgres whose COMMIT fails ───────────────────────────────────────────
{
  const db = pgliteDatabase((await PGlite.create()) as never);
  await migrate(db);
  let failCommit = false;
  const failing = {
    ...db,
    async tx<T>(fn: (q: import("../services/api/src/store/pg/sql.js").TxSql) => Promise<T>): Promise<T> {
      // PGlite rolls back when the callback throws: the throw after it ran
      // stands for a COMMIT the server refused.
      return db.tx(async (q) => {
        const out = await fn(q);
        if (failCommit) throw new Error("COMMIT failed");
        return out;
      });
    },
  };
  const pg = createPgStore(failing);
  await pg.addOrganisation({ id: "org_sc", type: "business", name: "Before", createdAt: now, updatedAt: now } as any, false);
  const { url, close } = await serve(app(pg));
  try {
    failCommit = true;
    const r = await fetch(`${url}/commit`, { method: "POST" });
    assert.equal(r.status, 500, "nothing was answered before the failed commit; the error handler answers");
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal((await pg.findOrganisation("org_sc"))?.name, "Before", "rolled back");
    failCommit = false;
    const ok = await fetch(`${url}/commit`, { method: "POST" });
    assert.equal(ok.status, 201);
    assert.equal((await pg.findOrganisation("org_sc"))?.name, "Committed");
  } finally {
    close();
    await pg.close();
  }
  console.log("ok - Postgres: a COMMIT that fails answers 500, never the held 201");
}

// ── JSON whose file write fails: nothing answered, exit 1 ─────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "zold-send-commit-child-"));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import express from "express";
      const { initStore, store } = await import("./services/api/src/store.ts");
      const { sendAfterCommit } = await import("./services/api/src/http/send-after-commit.ts");
      await initStore();
      const now = new Date().toISOString();
      await store.addOrganisation({ id: "org_c", type: "business", name: "Before", createdAt: now, updatedAt: now }, false);
      const app = express().use(sendAfterCommit);
      app.post("/commit", async (_req, res) => {
        fs.renameSync = () => { throw Object.assign(new Error("refused"), { code: "EIO" }); };
        syncBuiltinESMExports();
        await store.tx(async (t) => {
          await t.updateOrganisation("org_c", { name: "Refused" });
          res.status(201).json({ ok: true });
        });
      });
      const server = app.listen(0, "127.0.0.1", () => console.log("port " + server.address().port));
      `,
    ],
    { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, TRANSF_DB_PATH: path.join(dir, "db.json") } },
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const port = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const m = /port (\d+)/.exec(out);
      if (m) resolve(m[1]);
    });
    child.once("exit", () => reject(new Error(`child exited before listening: ${stderr}`)));
  });
  try {
    const answered = await fetch(`http://127.0.0.1:${port}/commit`, { method: "POST" }).then(
      (r) => r.status,
      () => "no answer",
    );
    assert.equal(answered, "no answer", "the held 201 never went out");
    assert.equal(await exited, 1, stderr);
    assert.match(stderr, /FATAL store write failed \(EIO\)/);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("ok - JSON: a file write that fails exits 1 with nothing answered");
}

// ── Partner and chain I/O refuse inside a transaction ─────────────────────
{
  const { writeAndWait, orchestratorWallet } = await import("../services/api/src/chain.js");
  const probe = express().get("/", (_req, res) => void res.send("ok"));
  const { url, close } = await serve(probe);
  try {
    assert.equal(await (await fetch(url)).text(), "ok", "fetch outside a transaction works");
    await assert.rejects(
      () => store.tx(async () => await fetch(url)),
      /fetch inside a store\.tx/,
    );
    // Through a helper, not written in the callback: the guard is at run time.
    const helper = async () => (await fetch(url)).text();
    await assert.rejects(() => store.tx(() => helper()), /fetch inside a store\.tx/);
    await assert.rejects(
      () => store.tx(() => writeAndWait(orchestratorWallet, { address: `0x${"00".repeat(20)}`, abi: [], functionName: "x", args: [] })),
      /writeAndWait inside a store\.tx/,
    );
    // A transaction that has ended does not taint what it started.
    const later = await store.tx(async () => () => fetch(url));
    assert.equal(await (await later()).text(), "ok");
  } finally {
    close();
  }
  console.log("ok - fetch and writeAndWait refuse inside a store.tx, also through a helper, and not after it");
}

rmSync(tmp, { recursive: true, force: true });
console.log("SEND AFTER COMMIT PASSED");
