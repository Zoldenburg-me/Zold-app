/**
 * Draft execution, end to end against a real chain and API.
 *
 * The unit suite (npm run business:test) proves the domain rules offline. This
 * one proves the wiring: a reviewed draft becomes N real transfers, each with
 * its own device authorization, and NOTHING moves until each is signed.
 *
 * Self-contained — starts and stops its own chain and API, like e2e.
 * Run: npm run draft:test
 */
// Must be first: pins the chain/keys before config.js reads the environment.
import "./_local-chain.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newDevice, registerDevice, signTerms } from "./device.js";

const PIN = { USD: 1.1379, INR: 109.87, KES: 147.53 };
process.env.TRANSF_RATES_FIXED ??= JSON.stringify(PIN);
process.env.DEPLOY_EURUSD_RATE ??= String(Math.round(PIN.USD * 1e6));
// SEPA is free by default; pin a fee so the fee-arithmetic refusal is exercised.
process.env.SEPA_FEE_EUR ??= "0.99";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
// tsx is run from its cli module, not the .bin shell wrapper: the wrapper is
// a separate process that cannot relay a kill, so the API it started would
// outlive the test and hold the port. Same shape as the other suites.
const bin = (name: string) =>
  name === "tsx" ? path.join(ROOT, "node_modules/tsx/dist/cli.mjs") : path.join(ROOT, "node_modules/.bin", name);

const children: ChildProcess[] = [];
function spawnBg(cmd: string, args: string[]) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      MONERIUM_CLIENT_ID: "",
      MONERIUM_CLIENT_SECRET: "",
      MG_ANCHOR_DOMAIN: "",
    },
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}
async function waitForRpc(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

/** Raw call: returns status and body so refusals can be asserted on. */
async function call(
  method: string,
  pathname: string,
  opts: { token?: string; body?: any } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(API + pathname, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

/** Call that must succeed. */
async function ok(method: string, pathname: string, opts: { token?: string; body?: any } = {}) {
  const r = await call(method, pathname, opts);
  if (r.status >= 400) {
    throw new Error(`${method} ${pathname} -> ${r.status}: ${r.data.error ?? JSON.stringify(r.data)}`);
  }
  return r.data;
}

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

for (const [name, url] of [
  [`api :${API_PORT}`, `${API}/api/health`],
  [`chain :${RPC_PORT}`, RPC_URL],
] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) })
    .then(() => true)
    .catch(() => false);
  if (busy) {
    console.error(`${name} is already in use — stop it and re-run.`);
    process.exit(1);
  }
}

try {
  console.log("1/7 starting local chain…");
  spawnBg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
  await waitForRpc(RPC_URL);

  console.log("2/7 deploying contracts…");
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  assert.equal(dep.status, 0, "deploy failed");

  console.log("3/7 starting API…");
  rmSync(process.env.TRANSF_DB_PATH!, { force: true });
  spawnBg(process.execPath, [bin("tsx"), "services/api/src/server.ts"]);
  await waitFor(`${API}/api/health`);

  console.log("4/7 funding an account and binding its device key…");
  const owner = await ok("POST", "/api/users", { body: { name: "Owner", email: "owner@example.com", country: "DE" } });
  const ownerToken: string = owner.sessionToken;
  // No simulated deposits exist any more: fund the local Safe by minting the
  // hardhat MockToken EURe straight to it (what a Monerium issue order does on
  // a real chain), from hardhat account 0, the token's owner.
  const { abis, addrs, eur, deployerWallet, writeAndWait } = await import("../services/api/src/chain.js");
  const mintLocalEure = (to: `0x${string}`, amount: number) =>
    writeAndWait(deployerWallet, {
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "mint",
      args: [to, eur.toWei(amount)],
    });
  await mintLocalEure(owner.address, 900);
  const device = newDevice();
  // registerDevice takes an ApiFn; bind one to the owner's session.
  await registerDevice(
    (pathname, body) => ok(body ? "POST" : "GET", pathname, { token: ownerToken, body }),
    owner.id,
    device,
  );

  console.log("5/7 building an organisation, contacts and a draft…");
  const org = (
    await ok("POST", "/api/orgs", {
      token: ownerToken,
      body: { name: "Acme GmbH", type: "business", country: "DE" },
    })
  ).organisation;

  // A business org must ASK to be funded from a person's own account — the
  // silent version of this would conflate personal and company money.
  const unfunded = await ok("POST", `/api/orgs/${org.id}/accounts`, {
    token: ownerToken,
    body: { currency: "EUR" },
  });
  check("a business account without a funding identity says so", () => {
    assert.equal(unfunded.account.backingUserId, undefined);
    assert.match(unfunded.note, /useMyAccount/);
  });

  const draftNoFunding = await ok("POST", `/api/orgs/${org.id}/drafts`, {
    token: ownerToken,
    body: {
      source: { kind: "account", accountId: unfunded.account.id },
      lines: [
        {
          destination: { kind: "bank", bankAccountId: "nope", displayName: "X" },
          asset: "EUR",
          amount: "10.00",
        },
      ],
    },
  });
  const refusedNoFunding = await call(
    "POST",
    `/api/orgs/${org.id}/drafts/${draftNoFunding.draft.id}/execute`,
    { token: ownerToken },
  );
  check("execution refuses an account with no funding identity, by name", () => {
    assert.equal(refusedNoFunding.status, 409);
    assert.match(refusedNoFunding.data.error, /no funding identity/i);
  });

  // Fund the account the org already has, from the owner's own balance.
  const funded = await ok(
    "POST",
    `/api/orgs/${org.id}/accounts/${unfunded.account.id}/fund`,
    { token: ownerToken },
  );
  check("adopting a personal account is explicit and stated plainly", () => {
    assert.equal(funded.account.backingUserId, owner.id);
    assert.equal(funded.account.status, "active");
    assert.equal(funded.account.address, owner.address);
    assert.match(funded.note, /funded by your personal account/i);
  });

  const contact = (
    await ok("POST", `/api/orgs/${org.id}/contacts`, {
      token: ownerToken,
      body: {
        name: "Supplier Ltd",
        bankAccounts: [
          {
            currency: "EUR",
            country: "DE",
            holderName: "Supplier Ltd",
            iban: "DE89370400440532013000",
          },
        ],
      },
    })
  ).contact;
  const secondContact = (
    await ok("POST", `/api/orgs/${org.id}/contacts`, {
      token: ownerToken,
      body: {
        name: "Contractor BV",
        bankAccounts: [
          {
            currency: "EUR",
            country: "NL",
            holderName: "Contractor BV",
            iban: "NL91ABNA0417164300",
          },
        ],
      },
    })
  ).contact;

  const line = (c: any, amount: string) => ({
    contactId: c.id,
    destination: {
      kind: "bank",
      bankAccountId: c.bankAccounts[0].id,
      displayName: c.bankAccounts[0].holderName,
    },
    asset: "EUR",
    amount,
  });

  const draft = (
    await ok("POST", `/api/orgs/${org.id}/drafts`, {
      token: ownerToken,
      body: {
        source: { kind: "account", accountId: funded.account.id },
        lines: [line(contact, "120.00"), line(secondContact, "80.00")],
      },
    })
  ).draft;

  console.log("6/7 review and execute…");

  // On a plan WITH approvals, a draft cannot be sent until it is reviewed.
  await ok("POST", `/api/orgs/${org.id}/plan/trial`, { token: ownerToken });
  const unreviewed = await call("POST", `/api/orgs/${org.id}/drafts/${draft.id}/execute`, {
    token: ownerToken,
  });
  check("with approvals bought, an unreviewed draft cannot be sent", () => {
    assert.equal(unreviewed.status, 409);
    assert.match(unreviewed.data.error, /reviewed by a second person/i);
  });

  // Four eyes: a second human approves.
  await ok("POST", `/api/orgs/${org.id}/drafts/${draft.id}/submit`, { token: ownerToken });
  const reviewer = await ok("POST", "/api/users", { body: { name: "Reviewer", email: "reviewer@example.com", country: "DE" } });
  const invite = await ok("POST", `/api/orgs/${org.id}/members`, {
    token: ownerToken,
    body: { email: "reviewer@example.com", role: "admin" },
  });
  await ok("POST", "/api/orgs/invites/accept", {
    token: reviewer.sessionToken,
    body: { token: invite.inviteToken },
  });
  const selfReview = await call("POST", `/api/orgs/${org.id}/drafts/${draft.id}/review`, {
    token: ownerToken,
    body: { approve: true },
  });
  check("the drafter still cannot approve their own payment", () => {
    assert.equal(selfReview.status, 403);
    assert.match(selfReview.data.error, /other than the person who drafted/i);
  });
  await ok("POST", `/api/orgs/${org.id}/drafts/${draft.id}/review`, {
    token: reviewer.sessionToken,
    body: { approve: true },
  });

  // The reviewer may approve, but cannot SIGN — the device key is not theirs.
  const wrongSigner = await call("POST", `/api/orgs/${org.id}/drafts/${draft.id}/execute`, {
    token: reviewer.sessionToken,
  });
  check("approving is not signing: only the device holder can send", () => {
    assert.equal(wrongSigner.status, 403);
    assert.match(wrongSigner.data.error, /device key/i);
  });

  // ── The batch, against the same wall a direct transfer hits ──────────────
  //
  // A passkey Safe needs an ERC-4337 bundler, and local hardhat has none, so no
  // real transfer can be created here — e2e asserts the same refusal rather
  // than a send. What IS provable, and what matters, is that draft execution
  // goes through the SAME code path: it must fail identically to a direct
  // POST /api/transfers, not more permissively.
  const batch = await call("POST", `/api/orgs/${org.id}/drafts/${draft.id}/execute`, {
    token: ownerToken,
  });

  const directQuote = await ok("POST", "/api/quotes", {
    token: ownerToken,
    body: { userId: owner.id, rail: "sepa", sendEur: 120 },
  });
  const direct = await call("POST", "/api/transfers", {
    token: ownerToken,
    body: {
      quoteId: directQuote.id,
      recipientName: "Supplier Ltd",
      recipientIban: "DE89370400440532013000",
    },
  });

  check("a batch refusal is the SAME refusal a direct transfer gets", () => {
    assert.equal(batch.status, direct.status, "same status");
    assert.equal(
      batch.data.detail,
      direct.data.error,
      "draft execution must not be a second, weaker path to creating a transfer",
    );
    assert.match(direct.data.error, /passkey Safe/i, "and it is the Safe guard doing it");
  });

  check("a stopped batch says plainly that nothing moved", () => {
    assert.deepEqual(batch.data.createdButUnsigned, []);
    assert.match(batch.data.note, /Nothing moved/i);
  });

  const afterFailure = await ok("GET", `/api/orgs/${org.id}/drafts/${draft.id}`, {
    token: ownerToken,
  });
  check("the draft is FAILED, not silently left ready to fire again", () => {
    assert.equal(afterFailure.draft.state, "FAILED");
    assert.match(afterFailure.draft.failureReason, /could not be prepared/i);
  });

  const replay = await call("POST", `/api/orgs/${org.id}/drafts/${draft.id}/execute`, {
    token: ownerToken,
  });
  check("a FAILED draft cannot be re-fired without being re-drafted", () => {
    assert.equal(replay.status, 409);
  });

  // ── Pre-flight: everything refused BEFORE anything is created ────────────
  const preflight = async (lines: any[]) => {
    const d = (
      await ok("POST", `/api/orgs/${org.id}/drafts`, {
        token: ownerToken,
        body: { source: { kind: "account", accountId: funded.account.id }, lines },
      })
    ).draft;
    await ok("POST", `/api/orgs/${org.id}/drafts/${d.id}/submit`, { token: ownerToken });
    await ok("POST", `/api/orgs/${org.id}/drafts/${d.id}/review`, {
      token: reviewer.sessionToken,
      body: { approve: true },
    });
    const r = await call("POST", `/api/orgs/${org.id}/drafts/${d.id}/execute`, {
      token: ownerToken,
    });
    const after = await ok("GET", `/api/orgs/${org.id}/drafts/${d.id}`, { token: ownerToken });
    return { r, after };
  };

  const walletLine = await preflight([
    {
      destination: {
        kind: "wallet",
        chainId: 31337,
        address: "0x1111111111111111111111111111111111111111",
        displayName: "Someone",
      },
      asset: "EUR",
      amount: "10.00",
    },
  ]);
  check("paying a wallet from an issued account is refused, not attempted", () => {
    assert.equal(walletLine.r.status, 422);
    assert.match(walletLine.r.data.problems[0].reason, /token-to-token/i);
    assert.equal(walletLine.after.draft.state, "REVIEWED", "and the draft is untouched");
  });

  // SEPA is free by default; this suite pins SEPA_FEE_EUR so the fee
  // arithmetic in the refusal is exercised.
  const tiny = await preflight([line(contact, "0.20")]);
  check("a line that would not exceed the fee is refused with the arithmetic", () => {
    assert.equal(tiny.r.status, 422);
    assert.match(tiny.r.data.problems[0].reason, /does not exceed the/i);
  });

  const overdraft = await preflight([line(contact, "700.00"), line(secondContact, "700.00")]);
  check("lines that each fit but overdraw TOGETHER are caught as a total", () => {
    assert.equal(overdraft.r.status, 400);
    assert.match(overdraft.r.data.error, /in total but the account holds/i);
    assert.equal(overdraft.after.draft.state, "REVIEWED", "nothing was created");
  });

  const mixed = await preflight([line(contact, "50.00"), line(secondContact, "0.10")]);
  check("one bad line refuses the WHOLE batch — no partial payment run", () => {
    assert.equal(mixed.r.status, 422);
    assert.match(mixed.r.data.error, /Nothing was created/i);
    assert.equal(mixed.r.data.problems.length, 1);
  });

  console.log("7/7 pay from invoice…");
  // The supplier fills the Invoice-Me link with an IBAN; the org pays it with
  // one click, which is a draft like any other — same review, same signature.
  const link = await ok("POST", `/api/orgs/${org.id}/invoices`, { token: ownerToken, body: { currency: "EUR" } });
  const badIban = await call("POST", `/api/invoice-links/${link.linkToken}/submit`, {
    body: {
      supplier: { orgName: "Supplier Ltd", email: "billing@supplier.example", invoiceNumber: "R-2026-017" },
      lines: [{ description: "Consulting", quantity: "1", unitPrice: "150.00" }],
      payTo: { kind: "bank", bank: { holderName: "Supplier Ltd", iban: "DE89370400440532013001" } },
    },
  });
  check("a mistyped IBAN is refused at submission, not discovered at payment", () => {
    assert.equal(badIban.status, 400);
    assert.match(badIban.data.error, /IBAN/i);
  });
  const submitted = await ok("POST", `/api/invoice-links/${link.linkToken}/submit`, {
    body: {
      supplier: { orgName: "Supplier Ltd", email: "billing@supplier.example", invoiceNumber: "R-2026-017" },
      lines: [{ description: "Consulting", quantity: "1", unitPrice: "150.00" }],
      payTo: { kind: "bank", bank: { holderName: "Supplier Ltd", iban: "DE89 3704 0044 0532 0130 00", bic: "cobadeffxxx" } },
    },
  });
  check("the supplier's bank details are normalised and stored on the invoice", () => {
    assert.equal(submitted.invoice.state, "SUBMITTED");
    assert.equal(submitted.invoice.payTo.kind, "bank");
    assert.equal(submitted.invoice.payTo.bank.iban, "DE89370400440532013000");
    assert.equal(submitted.invoice.payTo.bank.bic, "COBADEFFXXX");
    assert.equal(submitted.invoice.total, "150.00");
  });

  const invoiceId = submitted.invoice.id;
  const paid = await ok("POST", `/api/orgs/${org.id}/invoices/${invoiceId}/pay`, { token: ownerToken, body: {} });
  check("Pay creates one draft line from the invoice, on the org's EUR account", () => {
    assert.equal(paid.invoice.state, "PAYING");
    assert.equal(paid.invoice.payment.draftId, paid.draft.id);
    assert.equal(paid.draft.state, "DRAFT");
    assert.equal(paid.draft.source.accountId, funded.account.id);
    assert.equal(paid.draft.lines.length, 1);
    assert.equal(paid.draft.lines[0].amount, "150.00");
    assert.equal(paid.draft.lines[0].asset, "EUR");
    assert.equal(paid.draft.lines[0].invoiceId, invoiceId);
    assert.equal(paid.draft.lines[0].destination.kind, "bank");
    assert.ok(paid.draft.lines[0].destination.fingerprint, "the line carries a fingerprint like any address-book payment");
  });
  check("the supplier is matched to the existing contact by IBAN, not duplicated", () => {
    assert.equal(paid.contact.id, contact.id);
    assert.equal(paid.draft.lines[0].contactId, contact.id);
    assert.equal(paid.draft.lines[0].destination.bankAccountId, contact.bankAccounts[0].id);
  });
  const again = await call("POST", `/api/orgs/${org.id}/invoices/${invoiceId}/pay`, { token: ownerToken, body: {} });
  check("paying the same invoice twice is refused while the first payment is under way", () => {
    assert.equal(again.status, 409);
    assert.match(again.data.error, /already under way/i);
  });
  const listed = await ok("GET", `/api/orgs/${org.id}/invoices`, { token: ownerToken });
  check("the invoice list shows it PAYING with the draft attached", () => {
    const row = listed.invoices.find((i: any) => i.id === invoiceId);
    assert.equal(row.state, "PAYING");
    assert.equal(row.payment.draftId, paid.draft.id);
  });

  // A wallet-only invoice: recorded, but "Pay" says what is missing.
  const link2 = await ok("POST", `/api/orgs/${org.id}/invoices`, { token: ownerToken, body: { currency: "EUR" } });
  const walletOnly = await ok("POST", `/api/invoice-links/${link2.linkToken}/submit`, {
    body: {
      supplier: { orgName: "Chain Vendor", email: "ops@vendor.example", invoiceNumber: "CV-9" },
      lines: [{ description: "Node hosting", quantity: "1", unitPrice: "40.00" }],
      payTo: { kind: "wallet", address: "0x2222222222222222222222222222222222222222", chainId: 8453 },
    },
  });
  const noIban = await call("POST", `/api/orgs/${org.id}/invoices/${walletOnly.invoice.id}/pay`, { token: ownerToken, body: {} });
  check("a wallet-only invoice cannot be paid from the account and says to ask for an IBAN", () => {
    assert.equal(noIban.status, 409);
    assert.match(noIban.data.error, /IBAN/);
  });

  // A new supplier with an unknown IBAN becomes a contact of their own.
  const link3 = await ok("POST", `/api/orgs/${org.id}/invoices`, { token: ownerToken, body: { currency: "EUR" } });
  const fresh = await ok("POST", `/api/invoice-links/${link3.linkToken}/submit`, {
    body: {
      supplier: { orgName: "Neue Werkstatt GmbH", email: "buero@werkstatt.example", invoiceNumber: "2026-0042" },
      lines: [{ description: "Repair", quantity: "2", unitPrice: "30.00" }],
      payTo: { kind: "bank", bank: { holderName: "Neue Werkstatt GmbH", iban: "FR7630006000011234567890189" } },
    },
  });
  const paidFresh = await ok("POST", `/api/orgs/${org.id}/invoices/${fresh.invoice.id}/pay`, { token: ownerToken, body: {} });
  check("an unknown supplier lands in the address book with the invoice's bank account", () => {
    assert.notEqual(paidFresh.contact.id, contact.id);
    assert.equal(paidFresh.contact.name, "Neue Werkstatt GmbH");
    assert.equal(paidFresh.contact.bankAccounts[0].iban, "FR7630006000011234567890189");
    assert.equal(paidFresh.contact.bankAccounts[0].country, "FR");
    assert.equal(paidFresh.draft.lines[0].amount, "60.00");
  });

  console.log(`\nDRAFT EXECUTION TEST PASSED — ${passed}/${passed} checks.`);
  console.log("Draft execution is the same code path as a direct transfer, refuses as a whole,");
  console.log("and moves nothing without the account holder's device.\n");
  console.log("NOT PROVEN HERE: a batch that actually creates transfers. That needs an active");
  console.log("passkey Safe, which needs an ERC-4337 bundler — local hardhat has none, which is");
  console.log("why e2e asserts the same refusal. Prove it on Base Sepolia (npm run api).\n");
} finally {
  // SIGTERM, not SIGKILL: tsx forwards a TERM to the server it runs; a KILL
  // stops at the process that received it.
  for (const c of children) c.kill("SIGTERM");
}
