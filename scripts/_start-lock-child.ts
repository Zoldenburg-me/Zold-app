/**
 * A stand-in for the API's start (store-pg-test.ts): take the start lock,
 * then listen, as server.ts will once it runs on Postgres. Prints "listening"
 * once it listens. Exits 1 if the lock is held or later lost.
 *   START_LOCK_URL=postgresql:///db?host=/tmp tsx scripts/_start-lock-child.ts
 */
import http from "node:http";
import { takeStartLock } from "../services/api/src/store/pg/start-lock.js";

try {
  await takeStartLock({ connectionString: process.env.START_LOCK_URL }, { pingMs: Number(process.env.START_LOCK_PING_MS || 5000) });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => console.log("listening"));
