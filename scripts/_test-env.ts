/**
 * Pin the local-test security posture. No chain, RPC or DB.
 *
 * Separate from _local-chain.ts because pure-function suites need no chain at
 * all, but must still not inherit the operator's hosted posture.
 *
 * `.env` is the operator's file and carries the hosted deployment
 * (NODE_ENV=production, the zoldhq.com WebAuthn origin). `process.loadEnvFile`
 * fills anything unset, so without this every harness inherits it: pinned
 * test rates are refused as "set in production", and passkey ceremonies are
 * checked against an origin no test serves from.
 *
 * Set values, don't delete them: loadEnvFile would put the operator's value
 * back, in this process on the next call and in any child we spawn (same
 * problem as DEPLOY_*_KEY).
 *
 * NODE_ENV "test" behaves like unset, since the code only compares against
 * "production". Harnesses that want production posture (fx-rates-test) set it
 * themselves, and an explicit child env still wins.
 *
 * Must be the first import in any harness that uses it, or config.js is
 * evaluated with the operator's values.
 */
/**
 * The ports harnesses serve on. `npm run check` allocates a random free port
 * for the run and passes it as TRANSF_API_PORT, so RUN_PORT is added too.
 * Without it, WebAuthn ceremonies fail under `check` while every suite passes
 * on its own.
 */
const PORTS = [3000, 3010, 3011, 3012, 3020, 3021, 3030, 3040, 3100];
const RUN_PORT = process.env.TRANSF_API_PORT;

process.env.NODE_ENV = "test";
process.env.RP_ID = "localhost";
process.env.WEBAUTHN_ORIGINS = [...new Set([...PORTS.map(String), ...(RUN_PORT ? [RUN_PORT] : [])])].flatMap((p) => [
  `http://localhost:${p}`,
  `http://127.0.0.1:${p}`,
]).join(",");

/**
 * Operator gates: values whose presence changes whether a request is
 * accepted. They must be neutral here, or a harness tests the operator's
 * deployment. For example, reconcile-test posts an unsigned webhook, and a
 * secret inherited from .env rejects it before the reconciler runs.
 *
 * Not cleared: MONERIUM_CLIENT_ID/SECRET and MONERIUM_TOKEN_ENCRYPTION_KEY.
 * They permit rather than gate, the harnesses that care set their own, and
 * clearing them breaks sandbox-mode tests that expect credentials.
 *
 * A harness that wants a secret sets it in its own child env, which wins.
 */
process.env.MONERIUM_WEBHOOK_SECRET = "";
process.env.TRUSTED_PROXY_HOPS = "0";
// Every suite plays many users from one loopback address, and the challenge
// route now shares the tight auth bucket. security-hardening-test.ts sets the
// production value back and asserts the 429 itself.
process.env.AUTH_RATE_LIMIT_PER_MIN = "1000";
process.env.RECOVERY_MANAGED_KYC_GUARDIAN = "0";

/**
 * KYC_AUTO_APPROVE is a gate: with "0" a new user starts pending and never
 * receives an IBAN, so any harness that funds an account fails with a missing
 * iban rather than anything about KYC. Empty restores the inferred default
 * (auto-approve when LOOKS_LOCAL), which is what harnesses were written
 * against. A harness that wants the gate sets "0" in its own child env and
 * still wins.
 *
 * Deliberately NOT handled: ALLOW_PLAINTEXT_STORE (only read under
 * NODE_ENV=production, which is pinned away here) and MONERIUM_REDIRECT_URI
 * (config falls back to a derived localhost URL only when it is UNSET —
 * blanking it would break the OAuth loop rather than restore the default, and
 * monerium:oauth:test passes because it supplies its own).
 */
process.env.KYC_AUTO_APPROVE = "1";

export {};
