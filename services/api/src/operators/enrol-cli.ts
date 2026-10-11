/**
 * Start an operator's passkey enrolment, on the host that runs the API.
 *
 *   npm run operator:enrol -- --name "Ada Example" --email ada@example.com
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
import { OPERATOR } from "../config.js";
import { ENROLMENT_FILE, startEnrolment } from "./enrolment.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const name = flag("name");
const email = flag("email");
if (!name || !email) {
  console.error('usage: npm run operator:enrol -- --name "<full name>" --email <address>');
  process.exit(2);
}

const token = startEnrolment(name, email);
console.log(`Enrolment for ${name} written to ${ENROLMENT_FILE}; it expires in ${OPERATOR.enrolmentTtlMs / 60_000} minutes.`);
console.log("Open this link signed in to Cloudflare Access as that email, then clear your terminal's scrollback:");
console.log(`\n  ${OPERATOR.adminOrigin}/admin#enrol=${token}\n`);
