/**
 * Start an operator's passkey enrolment, on the host that runs the API.
 *
 *   npm run operator:enrol
 *
 * It asks for the operator's full name and email on stdin, or reads them from
 * OPERATOR_ENROL_NAME and OPERATOR_ENROL_EMAIL, so neither lands in shell
 * history. `--name`/`--email` on the command line are refused.
 *
 * Writes a single-use enrolment next to the store (only its hash of the
 * token) and prints the link that redeems it: open it within 15 minutes in a
 * browser signed in to Cloudflare Access as that email, and create the
 * passkey there. The token rides in the URL fragment, which no server or log
 * sees; it is printed here once and nowhere else. Running this again replaces
 * the open enrolment. An existing operator with the same email gets the new
 * passkey added; it is the way back in when every passkey is lost.
 *
 * Run it with the deployment's environment (TRANSF_DB_PATH, ADMIN_ORIGIN), so
 * the file lands in the store the API reads. It lives under services/api/src
 * because the production branch keeps nothing else.
 */
import { createInterface } from "node:readline";
import { OPERATOR } from "../config.js";
import { ENROLMENT_FILE, startEnrolment } from "./enrolment.js";

if (process.argv.slice(2).some((a) => /^--(name|email)\b/.test(a))) {
  console.error("operator:enrol no longer takes --name/--email (they stay in shell history); run it bare and answer the prompts, or set OPERATOR_ENROL_NAME and OPERATOR_ENROL_EMAIL");
  process.exit(2);
}

let lines: AsyncIterator<string> | undefined;
let rl: ReturnType<typeof createInterface> | undefined;
const ask = async (envName: string, question: string) => {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  rl ??= createInterface({ input: process.stdin });
  lines ??= rl[Symbol.asyncIterator]();
  process.stderr.write(question);
  const r = await lines.next();
  return r.done ? undefined : r.value.trim() || undefined;
};
const name = await ask("OPERATOR_ENROL_NAME", "Operator's full name: ");
const email = await ask("OPERATOR_ENROL_EMAIL", "Operator's email (their Cloudflare Access login): ");
rl?.close();
if (!name || !email) {
  console.error("usage: npm run operator:enrol, then answer the prompts (or set OPERATOR_ENROL_NAME and OPERATOR_ENROL_EMAIL)");
  process.exit(2);
}

const token = startEnrolment(name, email);
console.log(`Enrolment written to ${ENROLMENT_FILE}; it expires in ${OPERATOR.enrolmentTtlMs / 60_000} minutes.`);
console.log("Open this link signed in to Cloudflare Access as that email, then clear your terminal's scrollback:");
console.log(`\n  ${OPERATOR.adminOrigin}/admin#enrol=${token}\n`);
