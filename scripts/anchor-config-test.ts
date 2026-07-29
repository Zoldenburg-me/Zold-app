import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const node = process.execPath;

function readAsset(env: Record<string, string | undefined>) {
  const r = spawnSync(
    node,
    [
      "--import",
      "tsx",
      "--eval",
      "import('./services/api/src/config.ts').then(({ STELLAR }) => console.log(STELLAR.anchorAsset))",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  return r;
}

function asset(env: Record<string, string | undefined>) {
  const r = readAsset(env);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

let pass = 0;
const t = (label: string, fn: () => void) => {
  fn();
  pass++;
  console.log(`  ok  ${label}`);
};

console.log("Anchor asset config:");

t("defaults to SRT for the public Stellar test anchor path", () => {
  assert.equal(asset({ MG_ANCHOR_DOMAIN: "", MG_ANCHOR_ASSET: undefined }), "SRT");
  assert.equal(asset({ MG_ANCHOR_DOMAIN: "testanchor.stellar.org", MG_ANCHOR_ASSET: undefined }), "SRT");
});

t("selects USDC automatically for MoneyGram domains", () => {
  assert.equal(asset({ MG_ANCHOR_DOMAIN: "extmgxanchor.moneygram.com", MG_ANCHOR_ASSET: undefined }), "USDC");
});

t("allows explicit assets for non-MoneyGram anchors", () => {
  assert.equal(asset({ MG_ANCHOR_DOMAIN: "testanchor.stellar.org", MG_ANCHOR_ASSET: "native" }), "native");
});

t("refuses a non-USDC MoneyGram asset loudly", () => {
  const r = readAsset({ MG_ANCHOR_DOMAIN: "extmgxanchor.moneygram.com", MG_ANCHOR_ASSET: "SRT" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /incompatible with MoneyGram anchor/);
});

console.log(`\nANCHOR CONFIG TEST PASSED - ${pass}/4`);
