/**
 * The first operator's enrolment, started on the host.
 *
 * `npm run operator:enrol` writes one file next to the store, readable only
 * by its owner, holding the operator's name and email and the HASH of a
 * single-use token; the token itself is printed once, in the URL fragment of
 * the link it gives (a fragment is never sent to a server or a log). The API
 * reads the file when the link is redeemed and deletes it on success. Only
 * someone with a shell on the host can start an enrolment.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OPERATOR } from "../config.js";
import { DATA_DIR } from "../store/db.js";

export interface Enrolment {
  id: string;
  name: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
}

export const ENROLMENT_FILE = path.join(DATA_DIR, "operator-enrolment.json");

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Writes the enrolment file and returns the token for the link. `file` is
 *  another store's, for a suite that starts the API as a separate process. */
export function startEnrolment(name: string, email: string, now = Date.now(), file = ENROLMENT_FILE): string {
  const n = name.trim();
  const e = email.trim().toLowerCase();
  if (!n || n.length > 80) throw new Error("name must be 1-80 characters");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("email must be an email address");
  const token = randomBytes(24).toString("base64url");
  const enrolment: Enrolment = {
    id: `enr_${randomBytes(8).toString("hex")}`,
    name: n,
    email: e,
    tokenHash: hash(token),
    expiresAt: new Date(now + OPERATOR.enrolmentTtlMs).toISOString(),
  };
  // The chmod covers an existing file, whose old mode writeFileSync's `mode` would keep.
  writeFileSync(file, JSON.stringify(enrolment), { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/** The pending enrolment this token opens, or why it opens none. */
export function enrolmentFor(token: unknown): Enrolment | { refused: string } {
  if (typeof token !== "string" || !token) return { refused: "an enrolment link is required" };
  if (!existsSync(ENROLMENT_FILE)) return { refused: "no enrolment is open: start one on the host" };
  let e: Enrolment;
  try {
    e = JSON.parse(readFileSync(ENROLMENT_FILE, "utf8"));
  } catch {
    return { refused: "the enrolment file is unreadable: start a new one on the host" };
  }
  const a = Buffer.from(hash(token), "hex");
  const b = Buffer.from(String(e.tokenHash ?? ""), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { refused: "that enrolment link is not the open one" };
  if (!(Date.parse(e.expiresAt) > Date.now())) {
    // It names a person: an expired enrolment is not kept.
    endEnrolment();
    return { refused: "that enrolment link has expired: start a new one on the host" };
  }
  return e;
}

/** Used once: the link stops working the moment a passkey is enrolled. */
export function endEnrolment(): void {
  rmSync(ENROLMENT_FILE, { force: true });
}
