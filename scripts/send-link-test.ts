/**
 * Send links: the payer sets a limit and shares a link; the payee fills in an
 * amount within it, what it was for and where to be paid; the payer pays it
 * from the app's own send screens and ties that payment to the link, which
 * then follows the payment to PAID.
 *
 * In-process routers, no chain, no Monerium.
 *
 * Run: npm run send-link:test
 */
import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.TRANSF_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "zold-send-link-")), "db.json");
process.env.TRANSF_CHAIN_ID = "31337";
process.env.TRANSF_RPC_URL ??= "http://127.0.0.1:18545";
process.env.LOCAL_HARNESS = "";

const { initStore, store } = await import("../services/api/src/store.js");
const { resolveOrg } = await import("../services/api/src/routes/org-context.js");
const { createInvoiceLinkRouter, notifyRequester } = await import("../services/api/src/routes/business/invoice-links.js");
const { createInvoiceRoutes } = await import("../services/api/src/routes/business/invoices.js");
const { CHAIN_ID } = await import("../services/api/src/config.js");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${(err as Error).stack}`); process.exitCode = 1; }
};

initStore();
const now = new Date().toISOString();
store.addUser({ id: "u_tony", name: "Tony Payer", country: "DE", kycStatus: "approved", createdAt: now } as any);
store.addUser({ id: "u_other", name: "Olive Other", country: "DE", kycStatus: "approved", createdAt: now } as any);
store.addOrganisation({
  id: "org_p", type: "personal", name: "Tony Payer", legalName: "Tony Payer",
  address: { line1: "1 Main Street", postalCode: "10115", city: "Berlin", country: "DE" },
  reporting: { currency: "EUR", timeZone: "UTC", costBasisMethod: "FIFO" }, verifications: {},
  createdAt: now, updatedAt: now,
} as any);
store.addOrganisation({
  id: "org_b", type: "business", name: "Tony GmbH", legalName: "Tony GmbH",
  address: { line1: "1 Main Street", postalCode: "10115", city: "Berlin", country: "DE" },
  reporting: { currency: "EUR", timeZone: "UTC", costBasisMethod: "FIFO" }, verifications: {},
  createdAt: now, updatedAt: now,
} as any);
store.addMember({ id: "m_tony_b", orgId: "org_b", userId: "u_tony", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });
store.addMember({ id: "m_tony", orgId: "org_p", userId: "u_tony", email: "", role: "owner", status: "active", invitedAt: now, acceptedAt: now });

const app = express();
app.use(express.json());
const requireSession = (req: any, res: any) => {
  const id = req.header("x-user");
  if (id) return { userId: id };
  res.status(401).json({ error: "no session" });
  return undefined;
};
const ctxOf = (req: any, res: any) => resolveOrg(req, res, requireSession);
app.use("/api/orgs", createInvoiceRoutes({ ctxOf }));
app.use("/api/invoice-links", createInvoiceLinkRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, asUser?: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(asUser ? { "x-user": asUser } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
const newLink = async (maxTotal: string | number = "13", note?: string) => {
  const r = await call("POST", "/api/orgs/org_p/invoices", "u_tony", { sendLink: { maxTotal, ...(note ? { note } : {}) } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { id: r.data.invoice.id as string, token: r.data.linkToken as string, linkPath: r.data.linkPath as string };
};
const IBAN = "DE89370400440532013000";
const OTHER_IBAN = "DE89370400440532013001";
const WALLET = `0x${"ab".repeat(20)}`;
const fill = (token: string, over: Record<string, unknown> = {}) =>
  call("POST", `/api/invoice-links/${token}/submit`, undefined, {
    amount: "11.45", forWhat: "Dinner at Lotti", name: "Bob Example", payTo: { kind: "bank", bank: { iban: IBAN } }, ...over,
  });
const listed = async (id: string) => (await call("GET", "/api/orgs/org_p/invoices", "u_tony")).data.invoices.find((i: any) => i.id === id);
let seq = 0;
const transfer = (over: Record<string, unknown> = {}) => {
  const id = `tr_${++seq}`;
  store.addTransfer({ id, userId: "u_tony", rail: "sepa", recipientName: "Bob Example", recipientIban: IBAN, sendEur: 11.45, state: "CREATED", createdAt: new Date().toISOString(), updatedAt: now, ...over } as any);
  return id;
};
const cryptoSend = (over: Record<string, unknown> = {}) => {
  const id = `cs_${++seq}`;
  store.cryptoSends.push({ id, userId: "u_tony", to: WALLET, token: "EURE", amount: "11.45", capEur: 11.45, state: "SUBMITTED", deadline: Math.floor(Date.now() / 1000) + 600, createdAt: new Date().toISOString(), updatedAt: now, ...over } as any);
  return id;
};

console.log("\nMaking a send link");

await check("a send link is a euro link at /send/ with its limit in cents", async () => {
  const r = await call("POST", "/api/orgs/org_p/invoices", "u_tony", { sendLink: { maxTotal: "13,5", note: "Dinner" }, currency: "USD" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.linkPath, /^\/send\/.+/);
  assert.equal(r.data.invoice.currency, "EUR", "a send link is paid from euro whatever the request says");
  assert.deepEqual(r.data.invoice.sendLink, { maxTotal: "13.50", note: "Dinner" });
});

await check("a send link is made only in a personal org", async () => {
  const r = await call("POST", "/api/orgs/org_b/invoices", "u_tony", { sendLink: { maxTotal: "13" } });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /personal account/);
});

await check("a limit of zero, a word or over €10,000 is refused", async () => {
  for (const maxTotal of ["0", "abc", "10000.01", "1.234"]) {
    const r = await call("POST", "/api/orgs/org_p/invoices", "u_tony", { sendLink: { maxTotal } });
    assert.equal(r.status, 400, `${maxTotal}: ${JSON.stringify(r.data)}`);
  }
  const ok = await call("POST", "/api/orgs/org_p/invoices", "u_tony", { sendLink: { maxTotal: "10000" } });
  assert.equal(ok.status, 201);
});

await check("the link shows the note but never the limit, a hash or an org id", async () => {
  const l = await newLink("13.37", "Dinner");
  const r = await call("GET", `/api/invoice-links/${l.token}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.invoice.sendLink, { note: "Dinner" });
  assert.equal(r.data.invoice.payor.name, "Tony Payer");
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes("13.37") && !text.includes("maxTotal"), text);
  assert.ok(!text.includes("linkTokenHash") && !text.includes("org_p") && !text.includes("m_tony"), text);
  assert.deepEqual(r.data.payoutChains.map((c: any) => c.chainId), [CHAIN_ID]);
});

console.log("\nFilling it in");

await check("one cent over the limit is refused; exactly the limit is taken", async () => {
  const l = await newLink("13");
  const over = await fill(l.token, { amount: "13.01" });
  assert.equal(over.status, 400);
  assert.equal(over.data.code, "OVER_LIMIT");
  assert.ok(!over.data.error.includes("13"), over.data.error);
  const at = await fill(l.token, { amount: "13" });
  assert.equal(at.status, 200, JSON.stringify(at.data));
  assert.equal(at.data.invoice.state, "SUBMITTED");
  assert.equal(at.data.invoice.total, "13.00");
});

await check("five amounts over the limit lock the link's submit; the limit never shows", async () => {
  const l = await newLink("13");
  for (let i = 0; i < 5; i++) assert.equal((await fill(l.token, { amount: "20" })).status, 400);
  const locked = await fill(l.token);
  assert.equal(locked.status, 429, JSON.stringify(locked.data));
  assert.ok(!JSON.stringify(locked.data).includes("13"), locked.data.error);
});

await check("a filled-in link shows its destination masked; the payer's list has it in full", async () => {
  const l = await newLink("13");
  await fill(l.token);
  const pub = await call("GET", `/api/invoice-links/${l.token}`);
  assert.equal(pub.data.invoice.payTo.bank.iban, "DE89••••3000");
  assert.ok(!JSON.stringify(pub.data).includes(IBAN));
  assert.equal((await listed(l.id)).payTo.bank.iban, IBAN);
  const w = await newLink("13");
  await fill(w.token, { payTo: { kind: "wallet", chainId: CHAIN_ID, address: WALLET } });
  const wpub = await call("GET", `/api/invoice-links/${w.token}`);
  assert.ok(!JSON.stringify(wpub.data).toLowerCase().includes(WALLET), "wallet masked");
});

await check("what was filled in becomes one line, the name is the account holder, and the link locks", async () => {
  const l = await newLink("13");
  const r = await fill(l.token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const inv = r.data.invoice;
  assert.deepEqual(inv.lines, [{ description: "Dinner at Lotti", quantity: "1", unitPrice: "11.45", amount: "11.45" }]);
  assert.equal(inv.supplier.orgName, "Bob Example");
  assert.match(inv.supplier.invoiceNumber, /^LINK-[0-9A-F-]{8}$/);
  assert.equal(inv.payTo.kind, "bank");
  assert.equal(inv.payTo.bank.iban, "DE89••••3000", "the answer is masked too");
  assert.equal(store.findInvoice(l.id)?.payTo?.bank?.iban, IBAN, "stored in full for the payer");
  assert.equal(inv.payTo.bank.holderName, "Bob Example");
  const again = await fill(l.token, { amount: "1" });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, "This link was already filled in.");
  assert.equal(again.data.invoice.total, "11.45", "the second try changed nothing");
});

await check("no reason, no name, a bad IBAN, no destination or a wallet on another chain is refused", async () => {
  const l = await newLink("13");
  for (const over of [
    { forWhat: "" },
    { name: "B" },
    { payTo: { kind: "bank", bank: { iban: "DE00 1234" } } },
    { payTo: undefined },
    { payTo: { kind: "wallet", chainId: 1, address: WALLET } },
    { amount: "0" },
    { amount: "11.456" },
  ]) {
    const r = await fill(l.token, over);
    assert.equal(r.status, 400, `${JSON.stringify(over)}: ${JSON.stringify(r.data)}`);
  }
  assert.equal(store.findInvoice(l.id)?.state, "LINK_CREATED", "nothing refused moved the link");
});

await check("a wallet on this deployment's chain is taken", async () => {
  const l = await newLink("13");
  const r = await fill(l.token, { payTo: { kind: "wallet", chainId: CHAIN_ID, address: WALLET } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.invoice.payTo.kind, "wallet");
});

await check("the email for a filled-in send link is the send-link one", async () => {
  const l = await newLink("13");
  await fill(l.token);
  const inv = store.findInvoice(l.id)!;
  // No confirmed email on file: told nothing, and the send-link path is taken without throwing.
  assert.equal(await notifyRequester(inv, { mailOn: true }), "no-email");
});

console.log("\nPaying it");

await check("a bank payment ties on only if it is the caller's, to the link's IBAN, for the link's amount", async () => {
  const l = await newLink("13");
  await fill(l.token);
  const path = `/api/orgs/org_p/invoices/${l.id}/paying`;
  assert.equal((await call("POST", path, "u_tony", { transferId: transfer({ userId: "u_other" }) })).status, 404, "someone else's payment");
  assert.equal((await call("POST", path, "u_tony", { transferId: transfer({ recipientIban: OTHER_IBAN }) })).status, 409, "another IBAN");
  assert.equal((await call("POST", path, "u_tony", { transferId: transfer({ sendEur: 11.44 }) })).status, 409, "a cent short");
  assert.equal((await call("POST", path, "u_tony", { transferId: transfer({ state: "FAILED" }) })).status, 409, "a failed payment");
  assert.equal((await call("POST", path, "u_tony", { transferId: transfer({ createdAt: now }) })).status, 409, "made before the link was filled in");
  assert.equal((await call("POST", path, "u_tony", { transferId: transfer({ sendEur: 11.454 }) })).status, 409, "a fraction of a cent over");
  assert.equal((await call("POST", path, "u_tony", {})).status, 400, "no payment named");
  assert.equal(store.findInvoice(l.id)?.state, "SUBMITTED");

  const good = transfer();
  const r = await call("POST", path, "u_tony", { transferId: good });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.invoice.state, "PAYING");
  assert.equal((await call("POST", path, "u_tony", { transferId: good })).status, 409, "already being paid");

  const l2 = await newLink("13");
  await fill(l2.token);
  const twice = await call("POST", `/api/orgs/org_p/invoices/${l2.id}/paying`, "u_tony", { transferId: good });
  assert.equal(twice.status, 409);
  assert.match(twice.data.error, /already pays another link/);

  store.updateTransfer(good, { state: "PAID" } as any);
  assert.equal((await listed(l.id)).state, "PAID", "the link follows its transfer");
});

await check("a refunded bank payment puts the link back to pay", async () => {
  const l = await newLink("13");
  await fill(l.token);
  const t = transfer();
  await call("POST", `/api/orgs/org_p/invoices/${l.id}/paying`, "u_tony", { transferId: t });
  store.updateTransfer(t, { state: "REFUNDED" } as any);
  const inv = await listed(l.id);
  assert.equal(inv.state, "SUBMITTED");
  assert.equal(inv.payment?.transferId, undefined);
});

await check("a wallet payment ties on only to the link's address, in EURe, for exactly the amount", async () => {
  const l = await newLink("13");
  await fill(l.token, { payTo: { kind: "wallet", chainId: CHAIN_ID, address: WALLET } });
  const path = `/api/orgs/org_p/invoices/${l.id}/paying`;
  assert.equal((await call("POST", path, "u_tony", { cryptoSendId: cryptoSend({ to: `0x${"cd".repeat(20)}` }) })).status, 409, "another address");
  assert.equal((await call("POST", path, "u_tony", { cryptoSendId: cryptoSend({ token: "USDC" }) })).status, 409, "dollars");
  assert.equal((await call("POST", path, "u_tony", { cryptoSendId: cryptoSend({ amount: "11.454" }) })).status, 409, "a fraction of a cent over");
  assert.equal((await call("POST", path, "u_tony", { cryptoSendId: cryptoSend({ userId: "u_other" }) })).status, 404, "someone else's send");
  assert.equal((await call("POST", path, "u_tony", { cryptoSendId: cryptoSend({ state: "CREATED" }) })).status, 409, "never signed");
  assert.equal((await call("POST", path, "u_tony", { cryptoSendId: cryptoSend({ createdAt: now }) })).status, 409, "made before the link was filled in");
  assert.equal((await call("POST", path, "u_tony", { transferId: transfer() })).status, 409, "a bank payment for a wallet link");

  const good = cryptoSend({ amount: "11.450000", to: WALLET.toUpperCase().replace("0X", "0x") });
  const r = await call("POST", path, "u_tony", { cryptoSendId: good });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.invoice.state, "PAYING");
  store.updateCryptoSend(good, { state: "SENT", txHash: `0x${"ef".repeat(32)}` as `0x${string}` });
  const paid = await listed(l.id);
  assert.equal(paid.state, "PAID");
  assert.equal(paid.payment.txHash, `0x${"ef".repeat(32)}`);
});

await check("a failed wallet send puts the link back to pay", async () => {
  const l = await newLink("13");
  await fill(l.token, { payTo: { kind: "wallet", chainId: CHAIN_ID, address: WALLET } });
  const s = cryptoSend();
  await call("POST", `/api/orgs/org_p/invoices/${l.id}/paying`, "u_tony", { cryptoSendId: s });
  store.updateCryptoSend(s, { state: "FAILED" });
  assert.equal((await listed(l.id)).state, "SUBMITTED");
});

await check("only a filled-in send link can be tied to a payment", async () => {
  const open = await newLink("13");
  assert.equal((await call("POST", `/api/orgs/org_p/invoices/${open.id}/paying`, "u_tony", { transferId: transfer() })).status, 409, "not filled in yet");
  const plain = await call("POST", "/api/orgs/org_p/invoices", "u_tony", {});
  assert.equal(plain.status, 201);
  assert.equal((await call("POST", `/api/orgs/org_p/invoices/${plain.data.invoice.id}/paying`, "u_tony", { transferId: transfer() })).status, 404, "an ordinary invoice link");
  const stranger = await call("POST", `/api/orgs/org_p/invoices/${open.id}/paying`, "u_other", { transferId: transfer({ userId: "u_other" }) });
  assert.ok(stranger.status === 403 || stranger.status === 404, `someone outside the org: ${stranger.status}`);
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
