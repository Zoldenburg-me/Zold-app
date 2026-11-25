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
 * Hostile text in the PDF: parentheses, backslashes, CRLF, NUL and Unicode
 * stay inside their string (every content operator is one the writer emits),
 * a very long word is broken inside the margins, a free-text cell is cut
 * before the next one and the Beleg then names it in full, and the file name
 * is one safe path component whatever the stored date, code and reference say.
 *
 * Run: npm run beleg:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-beleg-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";

const { initStore, store } = await import("../services/api/src/store.js");
const { writeStatementLines } = await import("../services/api/src/bookkeeping/writer.js");
const { holderFor, issueBelegForLine } = await import("../services/api/src/bookkeeping/issue.js");
const { belegFileName, belegLines, belegPdf, belegStillAgrees, belegTitle, buildBeleg, UNEXECUTED_NOTE } = await import("../services/api/src/bookkeeping/beleg.js");
const { verifyZoldAttestation, snapshotDigest } = await import("../services/api/src/documents.js");
const { textPdf, winAnsi } = await import("../services/api/src/bookkeeping/pdf.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).message}`); process.exitCode = 1; }
};

const SAFE = `0x${"aa".repeat(20)}` as const;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const now = new Date().toISOString();

initStore();
const user: any = { id: "u_1", name: "Zoldenburg UG", country: "DE", kycStatus: "approved", address: SAFE, iban: "EE382200221020145685", createdAt: "2026-01-01T00:00:00.000Z", passkey: { credentialId: "c" }, passkeySafe: { status: "active", address: SAFE } };
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
  holding: "converted", settledAt: "2026-09-10T10:00:00.000Z", settlementAsset: "EURE", creditedEur: 119.62, provider: "dex", rate: 1.1452, midRate: 1.1403, realisedGainEur: -0.52,
  conversion: { userOpHash: H(6), txHash: H(7), blockNumber: 12, at: "2026-09-10T10:02:00.000Z", amountInUnits: "136500000", gasCostWei: "1200", gasPaidBy: "safe-token" },
  leftoverUnits: "500000",
  paymentRequestId: "pr_1",
  txs: [{ step: "safe.swap(usdc->eure)", hash: H(7) }, { step: "userOperation", hash: H(6) }],
  detectedAt: "2026-09-10T10:00:00.000Z", updatedAt: "2026-09-10T10:02:30.000Z",
};
store.addCryptoDeposit(deposit);
writeStatementLines();
const line = store.ledgerOf("org_1").find((e) => e.statement?.key === "deposit:d-1:disposal")!;
assert.ok(line, "the writer produced the disposal line");
const receiptLine = store.ledgerOf("org_1").find((e) => e.statement?.key === "deposit:d-1:held")!;
assert.ok(receiptLine, "the writer produced the receipt line");

console.log("\nSnapshot");

await check("the receipt line's Beleg is the receipt alone: value on arrival, no conversion", () => {
  const snap = buildBeleg(receiptLine, { holder: { name: "Zoldenburg UG", addressLines: [], safeAddress: SAFE, chainId: 31337, accountSince: now }, deposit, paymentRequest: store.findPaymentRequest("pr_1") });
  assert.equal(snap.line.event, "crypto_held");
  assert.equal(snap.line.amountCents, 12014);
  assert.equal(snap.receipt!.valueEur, 120.14);
  assert.equal(snap.conversion, undefined, "the disposal has its own line and its own Beleg");
  assert.equal(belegTitle(snap), "USDC received");
  // Converting later does not change what arrived.
  assert.equal(belegStillAgrees(snap, { entry: receiptLine, deposit }).ok, true);
  assert.equal(belegStillAgrees(snap, { entry: receiptLine, deposit: { ...deposit, holding: "held" } }).ok, true);
});

await check("a USDC-paid invoice's disposal Beleg carries every fact the accountant needs", () => {
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
  assert.equal(snap.line.amountCents, -52, "the disposal line is the realised gain");
  assert.equal(belegTitle(snap), "Held USDC converted to EURe (disposal)");
  assert.deepEqual(snap.gas, { costWei: "1200", paidBy: "safe-token" });
  assert.equal(snap.unexecutedNote, UNEXECUTED_NOTE, "rule 2: labelled until a swap has moved real money");
});

await check("an invoice-linked Beleg names the invoice's counterparty as that, and an older snapshot's `payer` still renders", () => {
  const holder = { name: "Zoldenburg UG", addressLines: [], safeAddress: SAFE, chainId: 31337, accountSince: now };
  // An outgoing payment of a supplier's invoice: the name is the payee's, so it is not a payer.
  const snap = buildBeleg(line, { holder, deposit, invoiceCounterpartyName: "Lieferant GmbH" });
  assert.deepEqual(snap.invoice, { number: "RE-2026-0042", counterparty: "Lieferant GmbH", source: "external" });
  assert.match(belegLines(snap, "ABCDE-FGHJK-MNPQR", now).map((l) => l.text).join("\n"), /RE-2026-0042 · Lieferant GmbH/);
  // Snapshots are frozen: one issued before the field was named for what it holds keeps `payer`.
  const old = { ...snap, invoice: { number: "RE-2026-0042", payer: "Kunde AG", source: "external" as const } };
  assert.match(belegLines(old, "ABCDE-FGHJK-MNPQR", now).map((l) => l.text).join("\n"), /RE-2026-0042 · Kunde AG/);
  const page = readFileSync(path.join(ROOT, "services/api/public/document.js"), "utf8");
  assert.match(page, /s\.invoice\.counterparty \?\? s\.invoice\.payer/, "the public page reads both");
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

console.log("\nHostile text in the PDF");

/** Every page's content stream, read by its /Length the way a viewer does. */
const contentStreams = (pdf: Buffer): string[] => {
  const body = pdf.toString("latin1");
  const out: string[] = [];
  const re = /<< \/Length (\d+) >>\nstream\n/g;
  for (let m; (m = re.exec(body)); ) {
    const start = m.index + m[0].length;
    const len = Number(m[1]);
    assert.equal(body.slice(start + len, start + len + 10), "\nendstream", "the stream ends where /Length says");
    out.push(body.slice(start, start + len));
  }
  return out;
};
// The only operators the writer emits: a text show or a hairline.
const TEXT_OP = /^(?:0\.38|0) g BT \/F[12] [\d.]+ Tf -?[\d.]+ -?[\d.]+ Td \(((?:[\x20-\x27\x2a-\x5b\x5d-\x7e]|\\[()\\]|\\[0-7]{3})*)\) Tj ET$/;
const RULE_OP = /^(?:0 G 0\.8|0\.85 G 0\.4) w [\d.]+ [\d.]+ m [\d.]+ [\d.]+ l S$/;
const shown = (pdf: Buffer): string[] => contentStreams(pdf).flatMap((c) => c.split("\n")).map((op) => {
  const m = TEXT_OP.exec(op);
  assert.ok(m || RULE_OP.test(op), `an operator the writer does not emit: ${JSON.stringify(op)}`);
  return m ? m[1].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, "$1") : undefined;
}).filter((t): t is string => t !== undefined);
const HOSTILE = ["a(b)c\\d)", ") Tj ET BT /F1 99 Tf 0 0 Td (owned", "x\r\ny\rz\n", "nul\u0000end\u0007", "endstream\nendobj\n%%EOF", "Müller € 東京 𝔘 \uD800", "\\) \\\\ ( \\("];

await check("parentheses, backslashes, CRLF, NUL and Unicode stay inside their string: no operator, stream or object can be injected", () => {
  const pdf = textPdf([
    ...HOSTILE.map((t) => ({ text: t })),
    ...HOSTILE.map((t) => ({ text: "", cells: [{ text: t, at: 0 }, { text: t, at: 1, align: "right" as const }] })),
  ], { title: HOSTILE.join(" "), author: ")>> /JavaScript (x)", subject: "\u0000\r\n)" });
  const streams = contentStreams(pdf);
  assert.equal(streams.length, Number(/\/Count (\d+)/.exec(pdf.toString("latin1"))![1]), "one content stream per page, none injected");
  const texts = shown(pdf);
  for (const t of HOSTILE) {
    const want = winAnsi(t).toString("latin1");
    assert.ok(texts.includes(want), `a cell shows ${JSON.stringify(t)} byte for byte (non-WinAnsi as ?)`);
    assert.ok(texts.join(" ").includes(want.split(/\s+/).filter(Boolean)[0]), "a wrapped line keeps its words");
  }
  const info = /5 0 obj\n([^\n]*)\nendobj/.exec(pdf.toString("latin1"))![1];
  assert.match(info, /^<< \/Title <FEFF[0-9A-F]*> \/Producer \(Zold\) \/Author <FEFF[0-9A-F]*> \/Subject <FEFF[0-9A-F]*> >>$/, "metadata is hex, never a literal string");
});

await check("a very long single word is broken across lines inside the margins, every character kept", () => {
  // Helvetica advance in points at 10 pt: W is the widest glyph; 東 prints as ?.
  for (const [ch, pt] of [["W", 8.3], ["i", 2.8], ["€", 5.56], ["東", 5.5]] as const) {
    const word = ch.repeat(3000);
    const want = winAnsi(word).toString("latin1");
    for (const [ln, room] of [[{ text: word }, 483.28], [{ text: `RE ${word} tail`, indent: 24, size: 7.5 }, 459.28]] as const) {
      const texts = shown(textPdf([ln], { title: "t" }));
      assert.equal(texts.join("").replace(/RE|tail|\s/g, ""), want, `${ch}: every character is on the page`);
      const widest = Math.max(...texts.map((t) => t.length * pt * ((ln as any).size ?? 10) / 10));
      assert.ok(widest <= room + 1, `${ch}: a line ${widest.toFixed(0)} pt wide runs past the margin`);
    }
  }
});

await check("a free-text cell too long for its column is cut with an ellipsis before the next cell, never drawn over the amount", () => {
  const long = "R".repeat(400);
  const texts = shown(textPdf([{ text: "", cells: [{ text: "26 October 2026", at: 0 }, { text: long, at: 0.2, clip: true }, { text: long, at: 0.52, clip: true }, { text: "+€33.00", at: 1, align: "right" }] }], { title: "t" }));
  const cut = texts.filter((t) => t.startsWith("R"));
  assert.equal(cut.length, 2);
  for (const t of cut) assert.ok(t.endsWith("\x85") && t.length < 60, `cut with … (${t.length} chars)`);
  assert.ok(texts.includes("+\x8033.00"), "the amount is drawn whole");
});

await check("the Beleg names a reference or counterparty its row had to cut in full under Booked against", () => {
  const reference = `RE-2026-0042 ${"Rechnungsnummer-und-Kundennummer-".repeat(4)}Ende`;
  const name = "Sehr Lange Firmenbezeichnung Gesellschaft mit beschraenkter Haftung und Co KG";
  const snap = buildBeleg({ ...line, statement: { ...line.statement!, reference, counterparty: { name } } } as any, { holder: { name: "Zoldenburg UG", addressLines: [], safeAddress: SAFE, chainId: 31337, accountSince: now }, deposit });
  const text = belegLines(snap, "ABCDEFGHJKMNPQR", now).map((l) => l.text).join("\n");
  assert.ok(text.includes(reference), "the full reference");
  assert.ok(text.includes(name), "the full counterparty");
  // Drawn whole somewhere (wrapped over lines), not only cut in the row.
  const pdfText = shown(belegPdf(snap, "ABCDEFGHJKMNPQR", now)).join("").replace(/\s/g, "");
  assert.ok(pdfText.includes(reference.replace(/\s/g, "")), "the PDF carries the full reference");
  assert.ok(pdfText.includes(name.replace(/\s/g, "")), "the PDF carries the full counterparty");
});

await check("a Beleg file name is one safe path component whatever the stored date, code and reference say", () => {
  const base = buildBeleg(line, { holder: { name: "Z", addressLines: [], safeAddress: SAFE, chainId: 31337, accountSince: now }, deposit });
  const cases: [string, string, string][] = [
    ["../../../etc/x", "../../evil", "../..\\a/b"],
    ["2026-09-10\r\nSet-Cookie: x", "ABC\"DEF", "\" ; filename=evil.exe"],
    ["/abs", "C:\\Windows", "É東𝔘\u0000\u202e"],
    ["", "", ""],
    ["..", "..", ".."],
  ];
  for (const [valueDate, code, reference] of cases) {
    const n = belegFileName({ ...base, line: { ...base.line, valueDate, reference } }, code);
    assert.match(n, /^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/, JSON.stringify([valueDate, code, reference, n]));
    assert.ok(!n.includes(".."), n);
  }
  assert.equal(belegFileName(base, "ABCDE-FGHJK-MNPQR"), "2026-09-10_ABCDEFGHJKMNPQR_RE-2026-0042.pdf", "a real one is unchanged");
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

await check("two issues for one line at once make one Beleg, not two", async () => {
  const fresh = { ...line, id: "led_race", statement: { ...line.statement!, key: "race", documentCode: undefined } } as any;
  store.addLedgerEntries([fresh]);
  const before = store.documents.length;
  const [a, b] = await Promise.all([issueBelegForLine(fresh), issueBelegForLine(fresh)]);
  assert.equal(a.doc.code, b.doc.code);
  assert.deepEqual([a.issued, b.issued].sort(), [false, true]);
  assert.equal(store.documents.length - before, 1);
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
  const unconverted = belegStillAgrees(snap, { entry, deposit: { ...store.cryptoDeposits[0], holding: "refused" } as any });
  assert.equal(unconverted.ok, false);
  assert.match(unconverted.detail, /now refused/);
  assert.match(belegStillAgrees(snap, { entry: undefined, deposit: store.cryptoDeposits[0] }).detail, /no longer exists/);
});

await check("the holder name says whether Monerium verified it, and a company name only borrows a verification it matches", () => {
  const u: any = { name: "Christian Lindner", iban: "", address: SAFE, createdAt: now };
  const approved = { ...u, monerium: { profileId: "p1", profiles: [{ id: "p1", kind: "personal", state: "approved", name: "Christian Lindner" }] } };
  assert.equal(holderFor(u, undefined).nameSource, "self-declared", "no IBAN, no approved profile: typed");
  assert.equal(holderFor(approved, undefined).nameSource, "monerium", "the approved profile verifies it before any IBAN");
  const corp = { id: "c1", kind: "corporate" as const, name: "Linder GmbH", checkedAt: now };
  assert.equal(holderFor(approved, corp).name, "Linder GmbH");
  assert.equal(holderFor(approved, corp).nameSource, "self-declared", "a company name Monerium did not verify is not verified");
  const ibanCo = { ...u, iban: "EE38 2200 2210 2014 5685", monerium: { ibans: [{ iban: "EE38 2200 2210 2014 5685", name: "LINDER GMBH" }] } };
  assert.equal(holderFor(ibanCo, corp).nameSource, "monerium", "Monerium names the company for the IBAN");
  const text = (h: any) => belegLines(buildBeleg(line, { holder: h, deposit }), "ABCDEFGHJKMNPQR", now).map((l) => l.text).join("\n");
  assert.match(text(holderFor(approved, undefined)), /Verified by Monerium/);
  assert.match(text(holderFor(u, undefined)), /Not verified: name as the holder entered it/);
});

console.log("\nPublic PDF");

await check("the public PDF is served while live and refused once revoked; the verify page still answers", async () => {
  const express = (await import("express")).default;
  const { createDocumentsRouter } = await import("../services/api/src/routes/documents.js");
  const server = express().use("/api", createDocumentsRouter({ requireUserSession: () => undefined } as any)).listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v`;
    const doc = store.documentsForOrg("org_1")[0];
    const live = await fetch(`${base}/${doc.code}/beleg.pdf`);
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("content-type"), "application/pdf");
    store.updateDocument(doc.id, { revokedAt: new Date().toISOString() });
    const revoked = await fetch(`${base}/${doc.code}/beleg.pdf`);
    assert.equal(revoked.status, 410);
    assert.equal(((await revoked.json()) as any).revoked, true);
    const page = (await (await fetch(`${base}/${doc.code}`)).json()) as any;
    assert.ok(page.revokedAt);
    assert.equal(page.verification.checks.find((c: any) => c.name === "Not revoked")?.ok, false);
  } finally {
    server.close();
  }
});

console.log(`\nbeleg: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
