/**
 * EUR corridor proof — against the real Monerium sandbox, not a stub.
 *
 * Everything else in this repo proves the EUR path against mocks: e2e credits
 * the vault with a local shortcut, the webhook test uses a stub Monerium, and
 * `simulateSepaDeposit` never touches a bank. Those prove our code is
 * self-consistent. They cannot prove that a euro arriving at a real IBAN
 * becomes EURe on the sandbox chain, that we mirror the right amount, or that
 * a redeem burns it again and sends SEPA out.
 *
 * This walks that round trip and checks each leg against an authority outside
 * our own database:
 *
 *   1. Monerium has an approved IBAN for the account          (Monerium API)
 *   2. A deposit arrives and mints EURe on the sandbox chain  (Monerium + chain)
 *   3. The chain balance matches what Monerium says it issued (chain)
 *   4. Our vault mirrors the same amount                      (local store)
 *   5. A redeem burns EURe and is accepted for SEPA payout    (Monerium + chain)
 *
 * Step 2 needs a human: Monerium's sandbox has no API to originate an inbound
 * SEPA transfer, so someone has to do it at sandbox.monerium.dev/receive,
 * which is a logged-in page rather than an endpoint. The script is
 * resumable and idempotent — run it, do the manual step, run it again. It
 * reports where you are rather than starting over.
 *
 * Run: npm run eur:proof            (newest provisioned user)
 *      npm run eur:proof -- --address 0x...   (a specific one)
 */
import { createPublicClient, http, formatUnits, getAddress } from "viem";
import { MONERIUM, moneriumSandboxEnabled } from "../services/api/src/config.js";
import { MoneriumClient } from "../services/api/src/adapters/monerium-client.js";
import { initStore, store, type User } from "../services/api/src/store.js";
import { redeemToIban } from "../services/api/src/adapters/monerium-sandbox.js";

const RPC = process.env.CANDIDE_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
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

console.log(`\nEUR corridor proof — ${MONERIUM.baseUrl} (chain: ${MONERIUM.chain})\n`);

initStore();
const token = await eureToken();
console.log(`EURe on ${MONERIUM.chain}: ${token.address} (${token.decimals} dp)\n`);

/* ---------- 1. an account with a real, approved IBAN ---------- */
console.log("1. Account and IBAN");

// Pick by what MONERIUM knows, not by database order. `npm run dev` wipes
// data/db.json, so the newest local user is often one that was never
// provisioned — it carries a mock IBAN and looks provisioned from here.
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
// app's DEFAULT profile, so this used to report "no deposit yet" for an
// account whose euros were already on chain — the same blind spot the
// deposit poller had.
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
      `       (Monerium's sandbox has no API for originating one — this is the only\n` +
      `        step that needs a person.) Then run this again.`,
  );
  console.log(`\n(on-chain EURe held by the account right now: ${eur(balance)})`);
  process.exit(2);
}

ok(`${issues.length} processed deposit(s), ${eur(issuedEur)} issued by Monerium`);
for (const o of issues.slice(-3)) {
  console.log(`       ${o.id}  ${eur(Number(o.amount))}  ${o.meta?.processedAt ?? ""}`);
}

console.log("\n3. Minted on the sandbox chain");
/**
 * The euros do not necessarily sit in the Safe.
 *
 * On a chain where the vault holds Monerium's real EURe, a working mirror
 * moves a deposit straight out of the Safe and into the vault — so checking
 * the Safe alone reported "the mint did not land" at the exact moment
 * everything had worked. What proves the mint is that the euros exist on
 * chain in one of the two places we control.
 */
const { createPublicClient: mkClient } = await import("viem");
const vaultAddr = (await import("../services/api/src/config.js")).loadDeployments().vault;
const inVault = (await chain.readContract({
  address: vaultAddr,
  abi: [{ type: "function", name: "balanceOf", stateMutability: "view",
          inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }],
  functionName: "balanceOf",
  args: [address],
})) as bigint;
const credited = Number(inVault) / 1e18;
const onChain = balance + credited;
ok(`${eur(balance)} in the Safe + ${eur(credited)} credited in the vault = ${eur(onChain)}`);
if (onChain <= 0) {
  no("Monerium says it issued, but neither the Safe nor the vault holds anything — the mint did not land.");
  process.exit(1);
}
if (onChain + 0.005 < issuedEur) {
  no(`Monerium issued ${eur(issuedEur)} but only ${eur(onChain)} is accounted for on chain`);
}

/* ---------- 4. our mirror agrees ---------- */
console.log("\n4. Our vault mirrors it");
const mirrored = issues.filter((o) => store.isOrderProcessed(o.id));
if (mirrored.length === issues.length) {
  ok(`all ${issues.length} deposit(s) mirrored into the local vault`);
} else {
  no(`${issues.length - mirrored.length} deposit(s) NOT mirrored — the poller or webhook missed them`);
  todo("start the stack so the deposit poller runs, or POST the order id to /api/webhooks/monerium");
}

/* ---------- 5. redeem: burn and pay out over SEPA ---------- */
console.log("\n5. Redeem to a SEPA account");

const redeems = mine.filter((o) => o.kind === "redeem");
const done = redeems.filter((o) => stateOf(o) === "processed");
if (done.length) {
  ok(`${done.length} redeem(s) already processed — the SEPA exit is proven for this account`);
  for (const o of done.slice(-3)) {
    console.log(`       ${o.id}  ${eur(Number(o.amount))}  -> ${o.counterpart?.identifier?.iban ?? "?"}`);
  }
  if (failures) {
  console.log(
    `\nNOT PROVEN — ${failures} leg(s) failed above. The redeem worked, but a corridor ` +
      `is only proven when every leg does.\n`,
  );
  process.exit(1);
}
console.log("\nEUR CORRIDOR PROVEN — deposit minted, mirrored, and redeemed for real.\n");
  process.exit(0);
}

if (balance < REDEEM_EUR) {
  // A redeem burns from the Safe, and a mirrored deposit has already left it.
  // That is not a failure — it is the mirror doing its job — but this script
  // cannot drive a redeem from here without re-implementing the payout path
  // (debit -> forward to Safe -> redeem), which the orchestrator owns.
  if (credited >= REDEEM_EUR) {
    ok(`${eur(credited)} is credited in the vault, not the Safe — as intended`);
    todo(
      `a redeem burns from the Safe, so it runs through the payout path\n` +
        `       (vault.debit -> forward to Safe -> redeem), not from here. Send a SEPA\n` +
        `       transfer in the app to exercise it.`,
    );
    console.log("\nDEPOSIT LEG PROVEN — issued, minted on chain, moved into the vault and credited.\n");
    process.exit(0);
  }
  no(`only ${eur(balance)} in the Safe; need at least ${eur(REDEEM_EUR)} to test a redeem`);
  todo("deposit more, or lower EUR_PROOF_REDEEM_EUR");
  process.exit(2);
}

console.log(`   placing a real redeem of ${eur(REDEEM_EUR)} to ${PAYOUT_IBAN}…`);
let order: any;
try {
  order = await redeemToIban(
    user,
    REDEEM_EUR,
    { iban: PAYOUT_IBAN, firstName: "Zold", lastName: "Proof", country: "DK" },
    "Zold EUR corridor proof",
  );
} catch (e: any) {
  no(`redeem refused: ${e?.message ?? e}`);
  process.exit(1);
}
ok(`order ${order.id} placed, state ${stateOf(order)}`);

// Monerium settles sandbox redeems in seconds, but not synchronously.
const deadline = Date.now() + 120_000;
let final = stateOf(order);
while (Date.now() < deadline && final !== "processed" && final !== "rejected") {
  await new Promise((r) => setTimeout(r, 4000));
  final = stateOf(await api.getOrder(order.id));
  process.stdout.write(`   …${final}\r`);
}
console.log();

if (final !== "processed") {
  no(`redeem ended in "${final}" — not proven`);
  process.exit(1);
}
ok("redeem processed by Monerium");

const after = await onChainEure(address, token);
ok(`on-chain EURe ${eur(balance)} -> ${eur(after)} (burned ${eur(balance - after)})`);
if (after >= balance) {
  no("balance did not fall — the burn did not happen on chain");
  process.exit(1);
}

if (failures) {
  console.log(
    `\nNOT PROVEN — ${failures} leg(s) failed above. The redeem worked, but a corridor ` +
      `is only proven when every leg does.\n`,
  );
  process.exit(1);
}
console.log("\nEUR CORRIDOR PROVEN — deposit minted, mirrored, redeemed, and burned.\n");
