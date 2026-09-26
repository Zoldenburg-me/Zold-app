/**
 * The Beleg — snapshot, signature, PDF bytes, re-verification — offline.
 *
 * A converted USDC deposit against an external (Lexware) invoice number is
 * the case the accountant needs: the document must carry the invoice and
 * payer, the receipt tx and block time, the ECB rate with its fixing day,
 * the conversion's chain tx and venue and amounts, the receivable
 * difference, the gain, and who paid gas. Then: issuing is once per line, the
 * PDF is a real PDF holding the same facts, a tampered snapshot fails, and a
 * deposit that changed under the document makes it fail verification.
 *
 * Run: npm run beleg:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-beleg-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";

const { initStore, store } = await import("../services/api/src/store.js");
const { writeStatementLines } = await import("../services/api/src/bookkeeping/writer.js");
const { issueBelegForLine } = await import("../services/api/src/bookkeeping/issue.js");
const { belegFileName, belegLines, belegPdf, belegStillAgrees, buildBeleg, UNEXECUTED_NOTE } = await import("../services/api/src/bookkeeping/beleg.js");
const { verifyZoldAttestation, snapshotDigest } = await import("../services/api/src/documents.js");
const { winAnsi } = await import("../services/api/src/bookkeeping/pdf.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).message}`); process.exitCode = 1; }
};

const SAFE = `0x${"aa".repeat(20)}` as const;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const now = new Date().toISOString();

initStore();
const user: any = { id: "u_1", name: "Zoldenburg UG", country: "DE", kycStatus: "approved", address: SAFE, iban: "EE382200221020145685", createdAt: now, passkey: { credentialId: "c" }, passkeySafe: { status: "active", address: SAFE } };
store.addUser(user);
store.addOrganisation({ id: "org_1", type: "business", name: "Zoldenburg UG", legalName: "Zoldenburg UG (haftungsbeschränkt)", plan: "business", reporting: { currency: "EUR", timeZone: "Europe/Berlin", costBasisMethod: "FIFO" }, verifications: {}, createdAt: now, updatedAt: now });
store.addAccount({ id: "acc_1", orgId: "org_1", currency: "EUR", label: "EUR", status: "active", provider: "monerium", identifier: { iban: "EE382200221020145685" }, address: SAFE, backingUserId: "u_1", createdAt: now, updatedAt: now });
store.addPaymentRequest({
  id: "pr_1", code: "ABCDEFGHJKMNPQR", userId: "u_1", orgId: "org_1", handle: "zold", amountEur: 119, currency: "EUR", methods: ["crypto"], state: "PAID",
  externalInvoiceNumber: "RE-2026-0042", cryptoQuotes: [], payments: [{ id: "p1", method: "crypto", ref: "deposit:d-1", depositId: "d-1", amountEur: 119, amountUsdc: 137, kind: "full", at: now }],
  source: { kind: "app" }, expiresAt: now, createdAt: now, updatedAt: now,
});
const deposit: any = {
  id: "d-1", userId: "u_1", chainId: 31337, token: "USDC", txHash: H(5), logIndex: 3, amountUnits: "137000000", amountUsdc: 137, from: `0x${"bb".repeat(20)}`,
  receipt: { amountEur: 120.14, rate: 1.1403, rateProvider: "ecb via api.frankfurter.dev", rateAsOf: "2026-09-10", ratedAt: "2026-09-10T10:00:00.000Z", blockTimestamp: "2026-09-10T09:58:00.000Z" },
  state: "CONVERTED", settlementAsset: "EURE", creditedEur: 119.62, provider: "dex", rate: 1.1452, midRate: 1.1403, realisedGainEur: -0.52,
  conversion: { userOpHash: H(6), txHash: H(7), blockNumber: 12, at: "2026-09-10T10:02:00.000Z", amountInUnits: "136500000", gasCostWei: "1200", gasPaidBy: "safe-token" },
  leftoverUnits: "500000",
  paymentRequestId: "pr_1",
  txs: [{ step: "safe.swap(usdc->eure)", hash: H(7) }, { step: "userOperation", hash: H(6) }],
  detectedAt: "2026-09-10T10:00:00.000Z", updatedAt: "2026-09-10T10:02:30.000Z",
};
store.addCryptoDeposit(deposit);
writeStatementLines();
const line = store.ledgerOf("org_1").find((e) => e.statement?.key === "deposit:d-1:converted")!;
assert.ok(line, "the writer produced the line");

console.log("\nSnapshot");

await check("a USDC-paid invoice's Beleg carries every fact the accountant needs", () => {
  const snap = buildBeleg(line, { holder: { name: "Zoldenburg UG", addressLines: ["DE"], iban: user.iban, safeAddress: SAFE, chainId: 31337, accountSince: now }, deposit, paymentRequest: store.findPaymentRequest("pr_1") });
  assert.equal(snap.kind, "beleg");
  assert.deepEqual(snap.invoice, { number: "RE-2026-0042", source: "external" });
  assert.equal(snap.receipt!.amount, 137);
  assert.equal(snap.receipt!.txHash, H(5));
  assert.equal(snap.receipt!.blockTime, "2026-09-10T09:58:00.000Z", "the receipt date is the chain's, for Ist-Versteuerung");
  assert.equal(snap.receipt!.valueEur, 120.14);
  assert.equal(snap.receipt!.rate, 1.1403);
  assert.equal(snap.receipt!.rateAsOf, "2026-09-10");
  assert.match(snap.receipt!.rateProvider!, /^ecb/);
  assert.equal(snap.conversion!.txHash, H(7), "the chain tx, not the userOp hash");
  assert.equal(snap.conversion!.userOpHash, H(6));
  assert.equal(snap.conversion!.at, "2026-09-10T10:02:00.000Z");
  assert.equal(snap.conversion!.venue, "dex");
  assert.equal(snap.conversion!.rate, 1.1452);
  assert.equal(snap.conversion!.amountInUsdc, 136.5);
  assert.equal(snap.conversion!.creditedEur, 119.62);
  assert.equal(snap.conversion!.leftoverUsdc, 0.5);
  assert.equal(snap.conversion!.receivableDifferenceEur, 0.62, "credited minus the invoice amount");
  assert.equal(snap.conversion!.gainEur, -0.52, "credited minus the value at receipt");
  assert.deepEqual(snap.gas, { costWei: "1200", paidBy: "safe-token" });
  assert.equal(snap.unexecutedNote, UNEXECUTED_NOTE, "rule 2: labelled until a swap has moved real money");
});

await check("the text rendering states the ECB rate is a daily fixing, and the PDF is a real PDF holding the facts", () => {
  const snap = buildBeleg(line, { holder: { name: "Zoldenburg UG", addressLines: [], safeAddress: SAFE, chainId: 31337, accountSince: now }, deposit });
  const text = belegLines(snap, "ABCDE-FGHJK-MNPQR", now).map((l) => l.text).join("\n");
  assert.match(text, /ECB reference rate for 2026-09-10 \(fixed once per business day; not an intraday rate\)/);
  assert.match(text, /Paid by: the account, in the gas token/);
  assert.match(text, /Left in the account: 0\.5 USDC/);
  const pdf = belegPdf(snap, "ABCDEFGHJKMNPQR", now);
  assert.ok(pdf.subarray(0, 8).toString("latin1").startsWith("%PDF-1.4"));
  const body = pdf.toString("latin1");
  assert.ok(body.includes("RE-2026-0042"), "the invoice number is in the page stream");
  assert.ok(body.includes(H(7)), "the conversion tx is in the page stream");
  assert.ok(body.endsWith("%%EOF\n"));
  assert.match(body, /\/Type \/Catalog/);
  const pages = Number(/\/Count (\d+)/.exec(body)![1]);
  assert.ok(pages >= 1 && pages <= 3, `${pages} pages`);
  assert.equal((body.match(/\/Type \/Page\b/g) ?? []).length, pages, "every page is in the tree");
  // xref offsets point at "N 0 obj"
  const startxref = Number(/startxref\n(\d+)\n/.exec(body)![1]);
  assert.equal(body.slice(startxref, startxref + 4), "xref");
  assert.equal(winAnsi("€ Müller — 東").toString("hex"), "80204dfc6c6c65722097203f", "euro and dash are WinAnsi; CJK is ?");
  assert.equal(belegFileName(snap, "ABCDEFGHJKMNPQR"), "2026-09-10_ABCDEFGHJKMNPQR_RE-2026-0042.pdf");
});

console.log("\nIssue, sign, verify");

await check("issuing is once per line and the code is written back onto the line", async () => {
  const first = await issueBelegForLine(line);
  assert.equal(first.issued, true);
  assert.equal(first.doc.kind, "beleg");
  assert.equal(first.doc.orgId, "org_1");
  assert.equal(first.doc.userId, "u_1");
  const again = await issueBelegForLine(store.ledgerOf("org_1").find((e) => e.id === line.id)!);
  assert.equal(again.issued, false);
  assert.equal(again.doc.code, first.doc.code);
  assert.equal(store.ledgerOf("org_1").find((e) => e.id === line.id)!.statement!.documentCode, first.doc.code);
  assert.equal(store.documentsForOrg("org_1").length, 1);
});

await check("the signature verifies; a changed figure fails", async () => {
  const doc = store.documentsForOrg("org_1")[0];
  assert.deepEqual(await verifyZoldAttestation(doc), { ok: true });
  const tampered: any = { ...doc, snapshot: { ...doc.snapshot, conversion: { ...(doc.snapshot as any).conversion, creditedEur: 1190.62 } } };
  assert.equal((await verifyZoldAttestation(tampered)).ok, false);
  assert.notEqual(snapshotDigest(tampered.snapshot), doc.attestations.zold.digest);
});

await check("re-verification checks the records the Beleg was built from", () => {
  const doc = store.documentsForOrg("org_1")[0];
  const snap = doc.snapshot as any;
  const entry = store.ledgerOf("org_1").find((e) => e.id === line.id)!;
  assert.equal(belegStillAgrees(snap, { entry, deposit: store.cryptoDeposits[0] }).ok, true);
  const corrected = { ...store.cryptoDeposits[0], creditedEur: 100 };
  const r = belegStillAgrees(snap, { entry, deposit: corrected as any });
  assert.equal(r.ok, false);
  assert.match(r.detail, /credited amount differs/);
  assert.match(belegStillAgrees(snap, { entry: undefined, deposit: store.cryptoDeposits[0] }).detail, /no longer exists/);
});

console.log(`\nbeleg: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
