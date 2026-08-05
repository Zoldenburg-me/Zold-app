import { execSync } from "node:child_process";

const INTERVAL_MS = 20 * 60 * 1000; // Poll every 20 minutes

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function autoSync() {
  const fetchRes = run("git fetch origin main");
  const localHead = run("git rev-parse HEAD");
  const remoteHead = run("git rev-parse origin/main");

  if (localHead && remoteHead && localHead !== remoteHead) {
    const status = run("git status --porcelain");
    if (status) {
      console.log(`[Auto-Sync] New commits found on origin/main, but local changes exist. Skipping auto-merge.`);
      return;
    }
    console.log(`[Auto-Sync] New commits detected on origin/main! Fast-forwarding local main...`);
    const mergeOutput = run("git merge --ff-only origin/main");
    const commitLog = run("git log -n 1 --oneline");
    console.log(`[Auto-Sync] ✅ Successfully synced! Current HEAD: ${commitLog}`);
  }
}

console.log(`🚀 Zold Auto-Sync Daemon Started (polling origin/main every ${INTERVAL_MS / 1000}s)...`);
autoSync();
setInterval(autoSync, INTERVAL_MS);
