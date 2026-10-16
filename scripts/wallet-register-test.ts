/**
 * The wallet register check preflight runs (scripts/wallet-register.ts), and
 * the shape of wallets.json itself. Offline: no chain, no .env.
 */
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { loadWalletRegister, walletRegisterProblems, type WalletRegister } from "./wallet-register.js";

// Obviously fake keys, built at run time so no key-shaped literal is in source.
const fake = (byte: string) => `0x${byte.repeat(32)}`;
const ORCHESTRATOR = fake("b2");
const ORCHESTRATOR_ADDRESS = privateKeyToAccount(ORCHESTRATOR as `0x${string}`).address;
const WITHDRAWER = `0x${"ab".repeat(20)}`;
const LOST = "0x3333333333333333333333333333333333333333";

const register: WalletRegister = {
  "8453": {
    [WITHDRAWER]: { role: "Candide custodial withdrawer", env: ["CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER"], keyHolder: "owner" },
    [ORCHESTRATOR_ADDRESS.toLowerCase()]: { role: "orchestrator", env: ["ORCHESTRATOR_KEY"], keyHolder: "server" },
    [LOST]: { role: "old withdrawer", env: ["CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER"], keyHolder: "unknown" },
  },
};

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

check("registered wallets with a known key holder pass, whatever the address case", () => {
  const env = { CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER: `0x${"AB".repeat(20)}`, ORCHESTRATOR_KEY: ORCHESTRATOR };
  assert.deepEqual(walletRegisterProblems(env, 8453, register), []);
  // The register keys the orchestrator in lower case; the derived address is checksummed.
  assert.notEqual(ORCHESTRATOR_ADDRESS, ORCHESTRATOR_ADDRESS.toLowerCase());
});

check("an unregistered withdrawer is refused", () => {
  const other = "0x2222222222222222222222222222222222222222";
  const problems = walletRegisterProblems({ CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER: other }, 8453, register);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER is 0x2{40}, which is not in wallets.json for chain 8453/);
});

check("a withdrawer whose key holder is unknown is refused", () => {
  const [p] = walletRegisterProblems({ CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER: LOST }, 8453, register);
  assert.match(p, /key holder is unknown — replace it/);
});

check("a wallet registered for another setting is refused", () => {
  const [p] = walletRegisterProblems({ CANDIDE_RECOVERY_GUARDIAN_ADDRESS: WITHDRAWER }, 8453, register);
  assert.match(p, /registered as Candide custodial withdrawer .*not for CANDIDE_RECOVERY_GUARDIAN_ADDRESS/);
});

check("a server key is checked by its address and the key never appears in a problem", () => {
  const key = fake("e5");
  const problems = walletRegisterProblems({ RELAY_KEY: key }, 8453, register);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes(privateKeyToAccount(key as `0x${string}`).address));
  assert.ok(!problems[0].includes(key.slice(2)));
});

check("the alias name of a key is checked when the main name is unset", () => {
  const [p] = walletRegisterProblems({ DEPLOY_ORCHESTRATOR_KEY: ORCHESTRATOR }, 8453, register);
  assert.match(p, /registered as orchestrator \(ORCHESTRATOR_KEY\), not for DEPLOY_ORCHESTRATOR_KEY/);
});

check("malformed values are refused, never skipped", () => {
  const problems = walletRegisterProblems({ CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER: "0x1234", RELAY_KEY: "nope" }, 8453, register);
  assert.deepEqual(problems, [
    "CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER is not an address",
    "RELAY_KEY is not a 32-byte hex private key",
  ]);
});

check("a chain with no register entries refuses every configured wallet", () => {
  assert.equal(walletRegisterProblems({ CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER: WITHDRAWER }, 1, register).length, 1);
});

check("nothing configured, nothing to refuse", () => {
  assert.deepEqual(walletRegisterProblems({}, 8453, register), []);
});

check("wallets.json: addresses, known settings and key holders only — never a key", () => {
  const real = loadWalletRegister();
  for (const [chain, wallets] of Object.entries(real)) {
    assert.match(chain, /^\d+$/);
    for (const [address, w] of Object.entries(wallets)) {
      assert.match(address, /^0x[0-9a-fA-F]{40}$/, `${chain} ${address}`);
      assert.deepEqual(Object.keys(w).sort(), ["env", "keyHolder", "role"], `${chain} ${address} has only role, env, keyHolder`);
      assert.ok(["server", "owner", "unknown"].includes(w.keyHolder), `${chain} ${address} keyHolder`);
      assert.ok(w.env.length > 0 && w.env.every((e) => /^[A-Z][A-Z0-9_]+$/.test(e)), `${chain} ${address} env`);
    }
  }
  assert.ok(!/[0-9a-fA-F]{64}/.test(JSON.stringify(real)), "wallets.json holds something key-shaped");
});

check("wallets.json refuses the mainnet withdrawer nobody holds the key for", () => {
  const [p] = walletRegisterProblems({ CANDIDE_FORWARDING_CUSTODIAL_WITHDRAWER: "0x2038A1179C4B9D7D04e7122017aD0FfD5FC7F364" }, 8453, loadWalletRegister());
  assert.match(p, /key holder is unknown/);
});

console.log(`wallet register: ${passed} passed`);
