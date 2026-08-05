/**
 * Lightweight GitHub Bot Utility
 *
 * Dependency-free script using native fetch to interact with the GitHub REST API.
 * Uses GITHUB_TOKEN or GH_TOKEN from environment (or --token parameter).
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx npx tsx scripts/github-bot.ts list-issues
 *   GITHUB_TOKEN=ghp_xxx npx tsx scripts/github-bot.ts create-issue --title "Title" --body "Body"
 *   GITHUB_TOKEN=ghp_xxx npx tsx scripts/github-bot.ts post-audit-issues
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Load .env if present
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

const DEFAULT_REPO = "Zoldenburg-me/Zold-app";

function getAuthToken(): string {
  const token =
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    getArg("--token");
  if (!token) {
    console.error("Error: GITHUB_TOKEN or GH_TOKEN is required.");
    console.error("Provide it via environment variable: GITHUB_TOKEN=ghp_xxx npx tsx scripts/github-bot.ts ...");
    process.exit(1);
  }
  return token;
}

function getRepo(): string {
  return getArg("--repo") || process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
}

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function githubApi(endpoint: string, method = "GET", body?: object) {
  const token = getAuthToken();
  const url = endpoint.startsWith("http") ? endpoint : `https://api.github.com${endpoint}`;
  
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Zold-GitHub-Bot/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub API Error (${res.status}): ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

export async function createIssue(title: string, body: string, labels: string[] = ["bug"]) {
  const repo = getRepo();
  console.log(`Creating issue on ${repo}: "${title}"...`);
  const issue = await githubApi(`/repos/${repo}/issues`, "POST", {
    title,
    body,
    labels,
  });
  console.log(`✓ Created issue #${issue.number}: ${issue.html_url}`);
  return issue;
}

export async function listIssues() {
  const repo = getRepo();
  const issues = await githubApi(`/repos/${repo}/issues?state=open`);
  console.log(`Found ${issues.length} open issues on ${repo}:`);
  for (const i of issues) {
    console.log(`  #${i.number} [${i.state}]: ${i.title} (${i.html_url})`);
  }
  return issues;
}

export async function postAuditBugs() {
  const auditBugs = [
    {
      title: "[BUG] 1-of-1 Safe Derivation Bug in transferTokenFromSafe Breaks Passkey 2-of-2 Accounts",
      labels: ["bug", "custody", "high-priority"],
      body: `### Description
In \`services/api/src/wallet/candide.ts\` (\`transferTokenFromSafe\`), the function derives the Safe address using \`smartAccountFor(owner.address)\`.

### Impact
For users with passkey 2-of-2 Safes (created via \`smartAccountForPasskeyCosigner\`), \`smartAccountFor(owner.address)\` derives an un-deployed 1-of-1 Safe address rather than the user's actual 2-of-2 Safe address. As a result, token debit calls fail with \`"Safe ... is not deployed"\` or target the wrong address.

### Location
- [\`services/api/src/wallet/candide.ts\`](file:///services/api/src/wallet/candide.ts#L322-L332)

### Recommended Fix
Pass the user's explicit \`passkeySafe\` configuration or target Safe address into \`transferTokenFromSafe\` to initialize the correct \`SafeAccount\` model.`,
    },
    {
      title: "[BUG] compensateTransfer Reads Hardcoded FxSwapper Rate Instead of Venue Execution Rate",
      labels: ["bug", "financial", "high-priority"],
      body: `### Description
During transfer failure recovery, \`compensateTransfer\` in \`services/api/src/orchestrator.ts\` reads the mock \`FxSwapper.rate\` contract to calculate \`eurBack\` from \`t.usdcOut\`.

### Impact
If a transfer executed a swap via Uniswap v3 (\`dex\`), CoW Protocol, LI.FI, or Bebop RFQ, querying \`FxSwapper.rate\` returns an arbitrary mock rate that does not reflect actual market execution rates. This leads to incorrect refund calculations for failed transfers.

### Location
- [\`services/api/src/orchestrator.ts\`](file:///services/api/src/orchestrator.ts#L386-L393)

### Recommended Fix
Read \`t.liquidity.rate\` stored on the transfer execution object or query the active liquidity provider's \`indicativeRate()\`.`,
    },
    {
      title: "[BUG] AdminTimelock Revives Stale Confirmations When Owner Is Re-Added",
      labels: ["bug", "smart-contracts", "security"],
      body: `### Description
In \`contracts/src/AdminTimelock.sol\`, \`removeOwner\` sets \`isOwner[who] = false\`, but historical \`confirmedBy[id][who]\` mapping entries are never deleted.

### Impact
If \`addOwner\` is subsequently called for the same address, \`liveConfirmations(id)\` iterates over current owners and checks \`confirmedBy[id][owners[i]]\`. Re-added owners will retroactively have their stale historical confirmations counted toward queued operations created before their removal.

### Location
- [\`contracts/src/AdminTimelock.sol\`](file:///contracts/src/AdminTimelock.sol#L129-L133)

### Recommended Fix
Reset \`confirmedBy\` mappings during owner removal or track owner generation indices per operation.`,
    },
  ];

  console.log(`Posting ${auditBugs.length} audit bugs as issues to ${getRepo()}...`);
  for (const bug of auditBugs) {
    await createIssue(bug.title, bug.body, bug.labels);
  }
  console.log("✓ All audit issues posted successfully!");
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "list-issues":
      await listIssues();
      break;
    case "create-issue": {
      const title = getArg("--title");
      const body = getArg("--body") || "";
      if (!title) {
        console.error("Error: --title parameter required");
        process.exit(1);
      }
      await createIssue(title, body);
      break;
    }
    case "post-audit-issues":
      await postAuditBugs();
      break;
    default:
      console.log(`
Lightweight GitHub Bot

Commands:
  post-audit-issues   Post all identified audit bugs directly to GitHub Issues
  list-issues         List open issues on repository
  create-issue        Create an issue (--title "..." --body "...")

Usage:
  GITHUB_TOKEN=your_personal_access_token npx tsx scripts/github-bot.ts post-audit-issues
`);
  }
}

main().catch((err) => {
  console.error("Fatal Error:", err.message);
  process.exit(1);
});
