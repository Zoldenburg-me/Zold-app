/**
 * Full verification runner.
 *
 * Some integration tests spin up a local API, Hardhat node, and stub provider.
 * Use free ports by default so `npm run check` does not fail just because a
 * developer has the demo API running on :3000.
 *
 * `npm run check` is OFFLINE: everything here runs against local hardhat and
 * stubs. The suites that reach Stellar testnet and a real anchor run under
 * `npm run check:live` (CHECK_LIVE=1), so a clean machine without egress can
 * still get a green check that means what it says.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { urlForLog } from "../services/api/src/http/log-safe.js";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const scripts = [
  "typecheck",
  "compile",
  "test:contracts",
  "webauthn:selftest",
  "authorize:test",
  "country:policy:test",
  "recovery:test",
  "recovery:remove:test",
  "recovery:candide:test",
  "turnkey:test",
  "turnkey-page:test",
  "turnkey-recovery:test",
  "documents:test",
  "paylinks:test",
  "shopify:test",
  "shopify:orders:test",
  "monerium:oauth:test",
  "monerium:apikeys:test",
  "monerium:iban-binding:test",
  "monerium:profile:test",
  "monerium:ratelimit:test",
  "display-name:test",
  "activity:test",
  "sepa:test",
  "receipt:test",
  "convert:test",
  "safe-op-uncertain:test",
  "device-key:test",
  "passkey-safe:test",
  "safe-signers:test",
  "safe-import:test",
  "safe-import:ui:test",
  "passkey-prompt:test",
  "offline-bar:test",
  "iban-moved:ui:test",
  "unread-balance:ui:test",
  "signout:test",
  "money-in:ui:test",
  "execution:test",
  "gas:test",
  "faucet:test",
  "quote-binding:test",
  "fx:test",
  "jit:test",
  "dex:test",
  "lifi:test",
  "forwarder:test",
  "wallet-register:test",
  "email:test",
  "recovery-alerts:test",
  "enrolment:test",
  "recovery-bank:test",
  "best:test",
  "webhook:test",
  "checkout-service:test",
  "merchant-links:test",
  "reconcile:test",
  "anchor:config:test",
  "anchor:safety",
  "anchor:sweep:test",
  "refund:guard:test",
  "relay-key:test",
  "safe-funded:test",
  "final-state:test",
  "business:test",
  "business:access:test",
  "recovery-alert:ui:test",
  "draft:test",
  "draft:failure:test",
  "payment-review:test",
  "deposit-invoice-link:test",
  "security:test",
  "crypto:test",
  "crypto-deposit:test",
  "crypto-in-getlogs:test",
  "org-migration:test",
  "production-branch:test",
  "identity:test",
  "free-features:test",
  "admin:test",
  "operator:test",
  "admin:ui:test",
  "review-resolution:test",
  "invoicing:test",
  "invoicing-profile:test",
  "async-errors:test",
  "input-errors:test",
  "vat:test",
  "org-accounts:test",
  "bounds:test",
  "custody:test",
  "segments:test",
  "gnosispay:test",
  "onboarding:test",
  "pay:test",
  "ens:test",
  "tx:audit:test",
  "statement:test",
  "wallet-sync:test",
  "income-invoices:test",
  "wallet-proof:test",
  "holdings:test",
  "org-ceiling:test",
  "beleg:test",
  "lexware:csv:test",
  "exact-output:test",
  "gmi:test",
];
const liveScripts = ["anchor:test", "travelrule:test", "trustline:test", "recovery:fork:test"];
if (process.env.CHECK_LIVE === "1") scripts.push(...liveScripts);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (!address || typeof address === "string") {
        s.close();
        reject(new Error("could not allocate a free port"));
        return;
      }
      const port = address.port;
      s.close(() => resolve(port));
    });
  });
}

const apiPort = process.env.TRANSF_API_PORT ?? String(await freePort());
const rpcPort = process.env.TRANSF_RPC_URL ? "" : String(await freePort());
const stubPort = process.env.TRANSF_STUB_PORT ?? String(await freePort());
const ratesStubPort = process.env.TRANSF_RATES_STUB_PORT ?? String(await freePort());
const env = {
  ...process.env,
  // Offline FX: a pinned swapper seed for deploy.ts, and both rate feeds on a
  // closed port, so a suite gets "no rate" (fail closed), never the network.
  DEPLOY_EURUSD_RATE: process.env.DEPLOY_EURUSD_RATE ?? "1137900",
  TRANSF_RATES_URL: "http://127.0.0.1:9/latest/EUR",
  TRANSF_ECB_RATES_URL: "http://127.0.0.1:9/v1",
  TRANSF_API_PORT: apiPort,
  TRANSF_RPC_URL: process.env.TRANSF_RPC_URL ?? `http://127.0.0.1:${rpcPort}`,
  TRANSF_STUB_PORT: stubPort,
  TRANSF_RATES_STUB_PORT: ratesStubPort,
};

console.log(`check ports: api=${env.TRANSF_API_PORT} rpc=${urlForLog(env.TRANSF_RPC_URL)} stub=${env.TRANSF_STUB_PORT} rates=${env.TRANSF_RATES_STUB_PORT}`);

for (const script of scripts) {
  const r = spawnSync(npm, ["run", script], { stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
