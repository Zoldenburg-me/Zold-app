/**
 * EUR corridor proof — against the real Monerium sandbox, not a stub.
 *
 * Everything else in this repo proves the EUR path against stubs: the harness
 * mints MockToken to the Safe and the webhook test uses a stub Monerium. Those
 * prove our code is self-consistent. They cannot prove that a euro arriving at a real IBAN
 * becomes EURe on the sandbox chain, that we record the right amount, or that
 * a redeem burns it again and sends SEPA out.
 *
 * This walks that round trip and checks each leg against an authority outside
 * our own database:
 *
 *   1. Monerium has an approved IBAN for the account          (Monerium API)
 *   2. A deposit arrives and mints EURe on the sandbox chain  (Monerium + chain)
 *   3. The chain balance is what Monerium issued minus what   (chain)
 *      it redeemed: the mint landed and each redeem burned
 *   4. Our local receipt state records the same amount        (local store)
 *   5. A redeem is processed for SEPA payout, carrying the    (Monerium + local store)
 *      payment reference we signed
 *
 * Step 2 needs a human: Monerium's sandbox has no API to originate an inbound
 * SEPA transfer, so someone has to do it at sandbox.monerium.dev/receive,
 * which is a logged-in page rather than an endpoint. Step 5 needs one too: a
 * redeem is valid only with the passkey's signature, so it is sent from the
 * app's SEPA send, the path that checks the memo against the signed record.
 * The script is
 * resumable and idempotent — run it, do the manual step, run it again. It
 * reports where you are rather than starting over.
 *
 * Run: npm run eur:proof            (newest provisioned user)
 *      npm run eur:proof -- --address 0x...   (a specific one)
 */
import { createPublicClient, http, formatUnits, getAddress } from "viem";
import { MONERIUM, RPC_URL, moneriumSandboxEnabled } from "../services/api/src/config.js";
import { MoneriumClient } from "../services/api/src/adapters/monerium-client.js";
import { initStore, store, type User } from "../services/api/src/store.js";
import { urlForLog } from "../services/api/src/http/log-safe.js";
import { ledgerGap, memoChecks } from "./eur-proof-core.js";

// The configured chain, never a hardcoded testnet: reading balances elsewhere
// reports "the mint did not land" against the wrong ledger.
const RPC = process.env.CANDIDE_RPC_URL ?? RPC_URL;
/** Where a proof redeem is sent. Monerium's own sandbox sample counterpart. */
const PAYOUT_IBAN = process.env.EUR_PROOF_IBAN ?? "DK5000400440116243";
const REDEEM_EUR = Number(process.env.EUR_PROOF_REDEEM_EUR ?? 1);

const argOf = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

let failures = 0;
const ok = (m: string) => console.log(`  \x1b[32mok\x1b[0m   ${m}`);
/** Records the failure as well as printing it: a leg that only warned still
 *  must not let the run announce itself as proven. */
const no = (m: string) => { failures++; console.log(`  \x1b[31mno\x1b[0m   ${m}`); };
const todo = (m: string) => console.log(`  \x1b[33m>>\x1b[0m   ${m}`);
const eur = (n: number) => `EUR ${n.toFixed(2)}`;

if (!moneriumSandboxEnabled()) {
  console.error("No Monerium credentials — set MONERIUM_CLIENT_ID / MONERIUM_CLIENT_SECRET in .env.");
  process.exit(1);
}
// The redeem asked for below goes to Monerium's sample IBAN. Against
// production that is real money, so the proof runs against the sandbox only.
if (!/monerium\.dev/.test(MONERIUM.baseUrl)) {
  console.error(`REFUSING: MONERIUM_BASE_URL is ${urlForLog(MONERIUM.baseUrl)}; this proof asks for a redeem and runs only against api.monerium.dev.`);
  process.exit(1);
}

const api = new MoneriumClient({
  baseUrl: MONERIUM.baseUrl,
  clientId: MONERIUM.clientId,
  clientSecret: MONERIUM.clientSecret,
});

/** Token contract for the configured chain, read from Monerium rather than
 *  hardcoded — a wrong address here would silently read zero and look like a
 *  failed deposit. */
async function eureToken(): Promise<{ address: `0x${string}`; decimals: number }> {
  const res = await fetch(`${MONERIUM.baseUrl}/tokens`);
  if (!res.ok) throw new Error(`GET /tokens -> ${res.status}`);
  const tokens = (await res.json()) as any[];
  const t = tokens.find(
    (x) => x.chain === MONERIUM.chain && x.currency === "eur" && x.kind === "evm" && x.address,
  );
  if (!t) throw new Error(`Monerium lists no EUR token on chain "${MONERIUM.chain}"`);
  return { address: getAddress(t.address), decimals: Number(t.decimals) };
}

const chain = createPublicClient({ transport: http(RPC) });

async function onChainEure(addr: `0x${string}`, token: { address: `0x${string}`; decimals: number }) {
  const bal = (await chain.readContract({
    address: token.address,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "a", type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [addr],
  })) as bigint;
  return Number(formatUnits(bal, token.decimals));
}

const orderList = (res: any) => (Array.isArray(res) ? res : (res?.orders ?? []));
const stateOf = (o: any) => o?.meta?.state ?? o?.state ?? "unknown";

console.log(`\nEUR corridor proof — ${urlForLog(MONERIUM.baseUrl)} (chain: ${MONERIUM.chain})\n`);

initStore();
const token = await eureToken();
console.log(`EURe on ${MONERIUM.chain}: ${token.address} (${token.decimals} dp)\n`);

/* ---------- 1. an account with a real, approved IBAN ---------- */
console.log("1. Account and IBAN");

// Pick by what MONERIUM knows, not by database order. `npm run dev` wipes
// data/db.json, so the newest local user is often one that was never
// provisioned and looks provisioned from here.
const ibanRes = (await api.ibans()) as any;
const ibans: any[] = Array.isArray(ibanRes) ? ibanRes : (ibanRes?.ibans ?? []);
const onMonerium = new Map<string, any>(
  ibans
    .filter((i: any) => i.chain === MONERIUM.chain && i.address)
    .map((i: any) => [getAddress(i.address), i]),
);

const wanted = argOf("--address");
const users: User[] = (store.users as User[]) ?? [];
const candidates = users.filter((u) => u.address && onMonerium.has(getAddress(u.address)));
const user = wanted
  ? users.find((u) => u.address.toLowerCase() === wanted.toLowerCase())
  : candidates.at(-1);

if (!user) {
  no(`no user in data/db.json has an IBAN on Monerium (${onMonerium.size} exist there).`);
  if (onMonerium.size) {
    todo("Monerium holds IBANs for these addresses, but this database has no matching user:");
    for (const [addr, i] of [...onMonerium].slice(-5)) console.log(`         ${addr}  ${i.iban}`);
    todo("`npm run dev` wipes data/db.json — onboard a fresh user and re-run.");
  } else {
    todo("start the stack (npm run dev) and onboard a user to provision one.");
  }
  process.exit(1);
}

const address = getAddress(user.address);
const record = onMonerium.get(address);
if (!record) {
  no(`Monerium has no IBAN for ${address} on ${MONERIUM.chain}`);
  process.exit(1);
}
ok(`${user.name} — ${address}`);
ok(`IBAN ${record.iban} (${record.state}) via ${record.bic}`);
if (record.state !== "approved") {
  no(`IBAN is "${record.state}", not approved — deposits will not land yet.`);
  process.exit(1);
}

/* ---------- 2 + 3. a real deposit, minted on the sandbox chain ---------- */
console.log("\n2. Inbound deposit");

// Scoped to this account's profile. An unscoped /orders returns only the
// app's DEFAULT profile and would report "no deposit yet" for an account
// whose euros are already on chain.
const orders = orderList(await api.orders(record.profile)) as any[];
const mine = orders.filter((o) => o.address && getAddress(o.address) === address);
const issues = mine.filter((o) => o.kind === "issue" && stateOf(o) === "processed");
const issuedEur = issues.reduce((s, o) => s + Number(o.amount), 0);
const balance = await onChainEure(address, token);

if (!issues.length) {
  no("no processed deposit for this account yet.");
  todo(
    `simulate an inbound SEPA transfer at https://sandbox.monerium.dev/receive\n` +
      `       to IBAN ${record.iban}\n` +
      `       (Monerium's sandbox has no API for originating one.) Then run this again.`,
  );
  console.log(`\n(on-chain EURe held by the account right now: ${eur(balance)})`);
  process.exit(2);
}

ok(`${issues.length} processed deposit(s), ${eur(issuedEur)} issued by Monerium`);
for (const o of issues.slice(-3)) {
  console.log(`       ${o.id}  ${eur(Number(o.amount))}  ${o.meta?.processedAt ?? ""}`);
}

const redeems = mine.filter((o) => o.kind === "redeem");
const done = redeems.filter((o) => stateOf(o) === "processed");

// A processed redeem burns its EURe, so the balance is checked against
// issued minus redeemed: that proves the mint and every burn at once, and a
// payout that empties the Safe still reaches step 5.
console.log("\n3. Minted (and burned) on the sandbox chain");
ok(`${eur(balance)} in the Safe`);
const gap = ledgerGap(issues, done, balance);
if (gap) no(gap);
else ok(`matches ${issues.length} deposit(s) less ${done.length} processed redeem(s)`);

/* ---------- 4. our mirror agrees ---------- */
console.log("\n4. Our mirror records it");
const mirrored = issues.filter((o) => store.isOrderProcessed(o.id));
if (mirrored.length === issues.length) {
  ok(`all ${issues.length} deposit(s) recorded locally`);
} else {
  no(`${issues.length - mirrored.length} deposit(s) NOT recorded — the poller or webhook missed them`);
  todo("start the stack so the deposit poller runs, or POST the order id to /api/webhooks/monerium");
}

/* ---------- 5. redeem: burn and pay out over SEPA ---------- */
console.log("\n5. Redeem to a SEPA account");

const ended = redeems.filter((o) => ["rejected", "failed"].includes(stateOf(o)));
for (const o of ended) todo(`${o.id} ${stateOf(o)} (${eur(Number(o.amount))}); it proves nothing and is not waited for`);
if (done.length) {
  ok(`${done.length} redeem(s) processed by Monerium`);
  // Every processed redeem placed from this database is compared with the
  // memo stored beside the passkey's signature, by the poller's rule. One
  // with no local transfer is listed and skipped: `npm run dev` wipes the db,
  // so an older order of this account need not be in it.
  const memos = memoChecks(done, (id) => {
    const t = store.transfers.find((x) => x.sepa?.orderId === id);
    return t ? { memo: t.moneriumRedeem?.memo } : undefined;
  });
  for (const m of memos.matched) {
    const o = done.find((x) => x.id === m.id);
    console.log(`       ${m.id}  ${eur(Number(o.amount))}  -> ${o.counterpart?.identifier?.iban ?? "?"}`);
    if (!m.differs) ok(`${m.id} carries the signed payment reference "${m.memo}"`);
    else no(`${m.id}: ${m.differs} — Monerium has "${o.memo ?? ""}", the transfer signed "${m.memo ?? ""}"`);
  }
  if (memos.unmatched.length) {
    todo(`${memos.unmatched.length} processed redeem(s) not placed from this database, not compared: ${memos.unmatched.join(", ")}`);
  }
  if (!memos.matched.length) {
    no("no processed redeem is a transfer in this database, so the payment reference is not proven");
    todo(`send ${eur(REDEEM_EUR)} to ${PAYOUT_IBAN} from the app's SEPA send, then run this again`);
  }
  if (failures) {
    console.log(`\nNOT PROVEN: ${failures} leg(s) failed above. A corridor is only proven when every leg is.\n`);
    process.exit(1);
  }
  console.log("\nEUR CORRIDOR PROVEN: deposit minted, mirrored, and redeemed with the signed payment reference.\n");
  process.exit(0);
}

const open = redeems.filter((o) => !ended.includes(o));
if (open.length) {
  todo(`${open.length} redeem(s) not processed yet (${open.map(stateOf).join(", ")}); run this again in a minute`);
  process.exit(2);
}
if (balance < REDEEM_EUR) {
  no(`only ${eur(balance)} in the Safe; need at least ${eur(REDEEM_EUR)} to test a redeem`);
  todo("deposit more, or lower EUR_PROOF_REDEEM_EUR");
  process.exit(2);
}
// No redeem is placed from here: Monerium takes one only with the Safe's
// signature, and the passkey is in the user's browser.
todo(`send ${eur(REDEEM_EUR)} to ${PAYOUT_IBAN} (Zold Proof, DK) from the app's SEPA send, then run this again`);
process.exit(2);
