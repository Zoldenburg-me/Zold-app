/**
 * Builds services/api/public/vendor/turnkey.js, the one Turnkey file the
 * browser loads: @turnkey/indexed-db-stamper (an unextractable P-256 key in
 * IndexedDB that stamps a guardian's own requests), bundled as an ES module.
 *
 * Not @turnkey/http: it pulls in X.509, ASN.1 and a DI container (636 KB) to
 * make one POST, so /guardian sends its stamped requests itself.
 *
 *     npm run vendor:turnkey          # rebuild after a version bump
 *     npm run vendor:turnkey -- --check   # exit 1 if the committed file differs
 *
 * The output depends only on the pinned package versions and the pinned
 * esbuild, so `--check` (run by turnkey-page:test) proves the committed file
 * is what these sources build. Record its SHA-256 in
 * docs/recovery-guardians-plan.md when it changes.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TURNKEY_BUNDLE = path.join(ROOT, "services/api/public/vendor/turnkey.js");
const PACKAGE = "@turnkey/indexed-db-stamper";

export async function buildTurnkeyBundle(): Promise<string> {
  const { version } = JSON.parse(readFileSync(path.join(ROOT, "node_modules", PACKAGE, "package.json"), "utf8"));
  const result = await build({
    stdin: { contents: `export { IndexedDbStamper } from "${PACKAGE}";\n`, resolveDir: ROOT, sourcefile: "turnkey-entry.js", loader: "js" },
    absWorkingDir: ROOT,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    legalComments: "inline",
    banner: { js: `/*! Zold vendor bundle: ${PACKAGE}@${version}, esbuild ${esbuildVersion}. Built by scripts/build-turnkey-bundle.ts; do not edit. */` },
    write: false,
    logLevel: "warning",
  });
  return result.outputFiles[0].text;
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildTurnkeyBundle();
  if (process.argv.includes("--check")) {
    const committed = readFileSync(TURNKEY_BUNDLE, "utf8");
    if (committed !== built) {
      console.error(`vendor/turnkey.js differs from what the pinned sources build (committed ${sha256(committed)}, built ${sha256(built)})`);
      process.exit(1);
    }
    console.log(`vendor/turnkey.js matches its sources: sha256 ${sha256(built)}`);
  } else {
    writeFileSync(TURNKEY_BUNDLE, built);
    console.log(`wrote vendor/turnkey.js (${built.length} bytes), sha256 ${sha256(built)}`);
  }
}
