import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { newDevice, registerDevice, signTerms } from "./scripts/device.js";

const API = "http://127.0.0.1:3000";
const db = JSON.parse(readFileSync("data/db.json","utf8"));
const us = Array.isArray(db.users)?db.users:Object.values(db.users??{});
const u:any = us[us.length-1];
let token = readFileSync("/tmp/claude-501/-Users-tonythomas-Documents-transF/f5ad0254-0ba1-41c6-98fb-4c8e059492d1/scratchpad/tok","utf8").trim();

async function api(path: string, body?: any) {
  const h: Record<string,string> = {};
  if (body) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...(body?{method:"POST",body:JSON.stringify(body)}:{}) , headers: h });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(`${path}: ${(d as any).error ?? res.statusText}`);
  return d as any;
}

console.log(`user ${u.name} ${u.address}`);
const me = await api(`/api/users/${u.id}`);
console.log(`  balance EUR ${me.balanceEur}`);

// FP4: the account needs a device key bound before it can authorise a payment.
// Reuse the same device key across runs: setAuthorizer is trust-on-first-use,
// so a fresh key each run would be refused by the contract.
const DEV_FILE = "/tmp/claude-501/-Users-tonythomas-Documents-transF/f5ad0254-0ba1-41c6-98fb-4c8e059492d1/scratchpad/device.json";
let device: any;
if (existsSync(DEV_FILE)) {
  device = JSON.parse(readFileSync(DEV_FILE, "utf8"));
  console.log(`  device reused: ${device.address}`);
} else {
  device = newDevice();
  writeFileSync(DEV_FILE, JSON.stringify(device));
  const bound = await registerDevice(api as any, u.id, device);
  console.log(`  device bound: ${bound.authorizerAddress}`);
}

if (process.env.BIND_ONLY) { console.log("  bound; waiting for a deposit"); process.exit(0); }
const quote = await api("/api/quotes", { userId: u.id, rail: "sepa", sendEur: 5 });
console.log(`  quote: send EUR ${quote.sendEur}, recipient gets EUR ${quote.receiveEur}, fee ${quote.fixedFeeEur}`);

const created = await api("/api/transfers", {
  quoteId: quote.id,
  recipientName: "Zold Tester",
  recipientIban: "DK5000400440116243",
});
console.log(`  transfer ${created.id} state=${created.state}`);
const signature = await signTerms(device, created.authorization.typedData);
const result = await api(`/api/transfers/${created.id}/authorize`, { signature });
console.log(`\n  state: ${result.state}`);
if (result.error) console.log(`  error: ${result.error}`);
for (const t of result.txs ?? []) console.log(`    ${t.step.padEnd(30)} ${t.hash}`);
if (result.sepa) console.log(`  sepa: ${JSON.stringify(result.sepa)}`);
