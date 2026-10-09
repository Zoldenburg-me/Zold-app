/**
 * scripts/build-production-branch.sh writes `production` only from merged
 * main, and never moves it back: a source must be on origin/main and descend
 * from the source of the current production commit (AGENTS.md rule 1).
 *
 * Runs the real script in a throwaway repo with a bare origin. The hardhat
 * compile and the lockfile install are shimmed on PATH: what is under test is
 * which source the script accepts, not the build.
 *
 * Offline. Run: npm run production-branch:test
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = path.join(ROOT, "scripts/build-production-branch.sh");
const tmp = mkdtempSync(path.join(os.tmpdir(), "zold-production-"));
const origin = path.join(tmp, "origin.git");
const repo = path.join(tmp, "repo");
const shims = path.join(tmp, "bin");

const env = {
  ...process.env,
  PATH: `${shims}:${process.env.PATH}`,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const build = (ref: string) => spawnSync("bash", [BUILDER, ref], { cwd: repo, env, encoding: "utf8" });
const localProduction = () => spawnSync("git", ["rev-parse", "-q", "--verify", "refs/heads/production"], { cwd: repo, env, encoding: "utf8" }).stdout.trim();
const commitFile = (name: string, body: string) => {
  writeFileSync(path.join(repo, name), body);
  git("add", "-A");
  git("commit", "-qm", name);
  return git("rev-parse", "HEAD");
};

let passed = 0;
const check = (label: string, cond: boolean, detail = "") => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`  ok  ${label}`);
};

try {
  // npx hardhat compile writes one ABI per contract; npm install is a no-op.
  mkdirSync(shims);
  writeFileSync(path.join(shims, "npx"), `#!/usr/bin/env bash
for sol in contracts/src/*.sol; do n="$(basename "$sol" .sol)"; mkdir -p "contracts/artifacts/contracts/src/$n.sol"
  echo "{\\"contractName\\":\\"$n\\",\\"abi\\":[]}" > "contracts/artifacts/contracts/src/$n.sol/$n.json"; done
`);
  writeFileSync(path.join(shims, "npm"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(path.join(shims, "npx"), 0o755);
  chmodSync(path.join(shims, "npm"), 0o755);

  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
  spawnSync("git", ["clone", "-q", origin, repo], { env });
  git("checkout", "-q", "-b", "main");
  mkdirSync(path.join(repo, "services/api/src"), { recursive: true });
  mkdirSync(path.join(repo, "contracts/src"), { recursive: true });
  mkdirSync(path.join(repo, "node_modules/hardhat"), { recursive: true });
  writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(path.join(repo, "contracts/src/A.sol"), "contract A {}\n");
  writeFileSync(path.join(repo, "tsconfig.json"), "{}\n");
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "z", devDependencies: { tsx: "1" } }));
  const m1 = commitFile("services/api/src/server.ts", "v1\n");
  const m2 = commitFile("services/api/src/server.ts", "v2\n");
  git("push", "-q", "origin", "main");

  // Production as the workflow left it: one snapshot whose source is M2.
  const seed = git("commit-tree", `${m2}^{tree}`, "-m", `Production snapshot of main@${m2.slice(0, 7)}`, "-m", `Source: ${m2}`);
  git("push", "-q", "origin", `${seed}:refs/heads/production`);

  // An unreviewed branch, pushed but never merged.
  git("checkout", "-q", "-b", "x/unmerged");
  const unmerged = commitFile("services/api/src/server.ts", "unreviewed\n");
  git("push", "-q", "origin", "x/unmerged");
  git("checkout", "-q", "main");

  console.log("production is written only from merged main, and never moves back");
  {
    const r = build(unmerged);
    check("a commit that is not on origin/main is refused", r.status !== 0, r.stdout + r.stderr);
    check("and production is not written", localProduction() === "", localProduction());
  }
  {
    const r = build(m1);
    check("a main commit older than production's source is refused", r.status !== 0, r.stdout + r.stderr);
    check("and production is not written", localProduction() === "", localProduction());
  }
  {
    const m3 = commitFile("services/api/src/server.ts", "v3\n");
    git("push", "-q", "origin", "main");
    const r = build(m3);
    check("the current main head builds", r.status === 0, r.stdout + r.stderr);
    const head = localProduction();
    check("on top of the production it found", git("rev-parse", `${head}^`) === seed);
    check("and names its source", git("log", "-1", "--format=%B", head).includes(`Source: ${m3}`));
  }
  console.log(`\nproduction branch: ${passed}/${passed} checks passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
