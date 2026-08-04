/**
 * Pin the local-test SECURITY POSTURE. Nothing else — no chain, no RPC, no DB.
 *
 * Split out from _local-chain.ts because the harnesses that need this are not
 * the same set that need a local chain: anchor/trustline/travel-rule talk to
 * real testnets on purpose and must NOT be pinned to 31337, but they still must
 * not inherit the operator's hosted posture.
 *
 * WHY THIS IS NEEDED AT ALL. `.env` is the operator's file and now legitimately
 * carries the hosted deployment — NODE_ENV=production and the zoldhq.com
 * WebAuthn origin. `process.loadEnvFile` fills anything unset, so without this
 * every harness silently inherits that: simulate routes 403 at the production
 * guard instead of reaching the guard under test, pinned test rates are refused
 * as "set in production", and passkey ceremonies are checked against an origin
 * no test ever serves from.
 *
 * SET, never delete. Deleting only lets loadEnvFile put the operator's value
 * back — in this process on the next call, and in any child we spawn. That is
 * the same trap the DEPLOY_*_KEY handling hit.
 *
 * The historical default was NODE_ENV unset; "test" is equivalent everywhere,
 * because the code only ever compares against "production". Harnesses that
 * genuinely want production posture (fx-rates-test, kyc-operator-test) set it
 * themselves, and an explicit child env still wins.
 *
 * MUST be the first import in any harness that uses it, or config.js is
 * evaluated with the operator's values already frozen in.
 */
/**
 * The ports harnesses serve on. The last entry is the one that matters under
 * `npm run check`, which allocates a RANDOM free port for the whole run and
 * passes it down as TRANSF_API_PORT — so a fixed list can never match it.
 *
 * The default this replaces was adaptive (config derives origins from
 * TRANSF_API_PORT). Pinning a static list quietly removed that, and the only
 * symptom was WebAuthn ceremonies failing under `check` while every suite
 * passed when run on its own.
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
 * Operator GATES — values whose mere presence changes whether a request is
 * accepted. These must be neutral by default or a harness ends up testing the
 * operator's deployment instead of the guard it was written for:
 * reconcile-test posts an unsigned webhook on purpose, and a secret inherited
 * from .env rejects it before the reconciler is ever reached.
 *
 * Deliberately NOT cleared: MONERIUM_CLIENT_ID/SECRET and
 * MONERIUM_TOKEN_ENCRYPTION_KEY. Those are permissive rather than gating, and
 * the harnesses that care already set their own — clearing them here would
 * break sandbox-mode tests that expect credentials to exist.
 *
 * A harness that wants a secret still sets it in its own child env, which wins.
 */
process.env.MONERIUM_WEBHOOK_SECRET = "";
process.env.TRUSTED_PROXY_HOPS = "0";
process.env.RECOVERY_MANAGED_KYC_GUARDIAN = "0";

/**
 * KYC_AUTO_APPROVE is a gate: with "0" a new user starts pending and never
 * receives an IBAN, so any harness that funds an account fails with a missing
 * iban rather than anything about KYC. Empty restores the inferred default
 * (auto-approve when LOOKS_LOCAL), which is what harnesses were written
 * against. kyc-test and kyc-operator-test set "0" in their own child env and
 * still win.
 *
 * Deliberately NOT handled: ALLOW_PLAINTEXT_STORE (only read under
 * NODE_ENV=production, which is pinned away here) and MONERIUM_REDIRECT_URI
 * (config falls back to a derived localhost URL only when it is UNSET —
 * blanking it would break the OAuth loop rather than restore the default, and
 * monerium:oauth:test passes because it supplies its own).
 */
process.env.KYC_AUTO_APPROVE = "";

export {};
