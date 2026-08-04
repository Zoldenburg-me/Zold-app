/**
 * Prove the Stellar payout leg on real testnet — the part that has never run.
 *
 * WHAT WAS ALREADY PROVEN: SEP-10 auth and opening a SEP-24 withdrawal
 * (npm run stellar:check), and that the treasury can hold the asset
 * (npm run trustline:test). What has NEVER happened is the thing that actually
 * moves value: an ON-LEDGER PAYMENT to the anchor, carrying its memo, observed
 * by the anchor and driven to a terminal state. Until that runs, "live anchor
 * payouts" is a claim about code that has only ever been read.
 *
 * WHY SEP-6 AND NOT SEP-24. SEP-24 hands the user an interactive web form, so a
 * withdrawal sits at `incomplete` and never publishes an account or memo until
 * a human finishes it — which is exactly where stellar:check stops today.
 * SEP-6 is the non-interactive sibling: same SEP-10 auth, same ledger payment,
 * same memo semantics, but it returns `account_id` and `memo` directly, so the
 * payment path can be exercised without a browser. The Stellar mechanics being
 * proven here — trustline, asset payment, memo type, submission, anchor
 * observation — are identical.
 *
 * Nothing here is a mock: real testnet, real anchor, real ledger.
 *
 * Run: npm run stellar:payout:live
 */
import "./_test-env.js";
import { Asset, BASE_FEE, Horizon, Keypair, Memo, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { STELLAR } from "../services/api/src/config.js";
import { getTreasury, sep10Auth } from "../services/api/src/stellar/anchor.js";

const HOME = process.env.MG_ANCHOR_DOMAIN || "testanchor.stellar.org";
/**
 * Default `native` (XLM) because it is the one asset the treasury actually
 * holds. testanchor lists SRT/USDC/native for withdrawal, but it will not
 * credit a SEP-6 deposit of SRT for us — its deposit sits at `incomplete`
 * even with SEP-12 ACCEPTED — so an SRT run proves nothing about the payment
 * path, only about their test faucet.
 *
 * The mechanics being proven are asset-independent: SEP-10 auth, the anchor
 * publishing an account and memo, an on-ledger payment carrying that memo, and
 * the anchor observing it. In production the asset is USDC, which the treasury
 * would hold for real.
 */
const CODE = process.env.STELLAR_LIVE_ASSET || "native";
const AMOUNT = process.env.STELLAR_LIVE_AMOUNT || "1";
const HORIZON = STELLAR.horizon || "https://horizon-testnet.stellar.org";
const SEP6 = `https://${HOME}/sep6`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const say = (m: string) => console.log(`${++step}. ${m}`);

async function api(path: string, jwt: string) {
  const res = await fetch(`${SEP6}${path}`, { headers: { authorization: `Bearer ${jwt}` } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** Poll a SEP-6 transaction until it leaves the given status, or give up. */
async function waitFor(jwt: string, id: string, leave: string[], budgetMs = 120_000) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < budgetMs) {
    const { transaction } = await api(`/transaction?id=${encodeURIComponent(id)}`, jwt);
    if (transaction.status !== last) {
      last = transaction.status;
      console.log(`      status: ${last}`);
    }
    if (!leave.includes(transaction.status)) return transaction;
    await sleep(4000);
  }
  throw new Error(`timed out waiting for ${id} to leave ${leave.join("/")} (last: ${last})`);
}

const treasury: Keypair = await getTreasury();
const server = new Horizon.Server(HORIZON);
const passphrase = STELLAR.networkPassphrase || Networks.TESTNET;

console.log(`anchor ${HOME} · asset ${CODE} · amount ${AMOUNT}`);
console.log(`treasury ${treasury.publicKey()}\n`);

const isNative = CODE === "native";
const balanceOf = async (code: string) => {
  const acc = await server.loadAccount(treasury.publicKey());
  const b = acc.balances.find((x: any) =>
    code === "native" ? x.asset_type === "native" : x.asset_code === code);
  return b ? Number((b as any).balance) : 0;
};

// --- 1. auth ---------------------------------------------------------------
const jwt = await sep10Auth(HOME, treasury);
say(`SEP-10 authenticated as the treasury (jwt ${jwt.slice(0, 16)}…)`);

// --- 2. acquire the asset --------------------------------------------------
let held = await balanceOf(CODE);
say(`treasury holds ${held} ${CODE}`);

if (!isNative && held < Number(AMOUNT)) {
  const dep = await api(
    `/deposit?asset_code=${CODE}&account=${treasury.publicKey()}&amount=${AMOUNT}&type=bank_account`,
    jwt,
  );
  say(`SEP-6 deposit opened (${dep.id ?? "no id"}) — testanchor credits test deposits itself`);
  if (dep.id) await waitFor(jwt, dep.id, ["incomplete", "pending_anchor", "pending_user_transfer_start", "pending_external"]);
  for (let i = 0; i < 15 && held < Number(AMOUNT); i++) {
    await sleep(4000);
    held = await balanceOf(CODE);
  }
  say(`treasury now holds ${held} ${CODE}`);
}

if (held < Number(AMOUNT)) {
  console.error(
    `\nREFUSING: treasury holds ${held} ${CODE}, need ${AMOUNT}. The anchor did not credit the deposit, ` +
      `so there is nothing to pay with — not a failure of the payment path, which is untested either way.`,
  );
  process.exit(1);
}

// --- 3. open a withdrawal and read where to pay ----------------------------
const wd = await api(
  `/withdraw?asset_code=${CODE}&type=bank_account&dest=DE89370400440532013000&amount=${AMOUNT}`,
  jwt,
);
say(`withdrawal ${wd.id} opened`);

// The open response carries only an id. Where to pay is published later, when
// the anchor reaches pending_user_transfer_start — which is why the production
// path reads it from the transaction rather than the open call, and why
// sendSep24WithdrawalPayment refuses outright when it is absent.
let dest = "";
let memo: string | undefined;
let memoType: string | undefined;
{
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 120_000) {
    const { transaction: t } = await api(`/transaction?id=${encodeURIComponent(wd.id)}`, jwt);
    if (t.status !== last) { last = t.status; console.log(`      status: ${last}`); }
    if (t.withdraw_anchor_account) {
      dest = t.withdraw_anchor_account; memo = t.withdraw_memo; memoType = t.withdraw_memo_type;
      break;
    }
    if (t.status === "error" || t.status === "refunded") throw new Error(`anchor gave up: ${t.status}`);
    await sleep(4000);
  }
}
if (!dest) throw new Error("anchor never published withdraw_anchor_account — nothing to pay, and refusing to guess");
say(`anchor wants ${dest.slice(0, 8)}… memo=${memo} (${memoType})`);

// --- 4. THE PAYMENT — real value moving on a real ledger -------------------
const account = await server.loadAccount(treasury.publicKey());
const asset = isNative
  ? Asset.native()
  : new Asset(CODE, wd.asset_issuer ?? (await (async () => {
      const acc = await server.loadAccount(treasury.publicKey());
      const b: any = acc.balances.find((x: any) => x.asset_code === CODE);
      return b?.asset_issuer;
    })()));

const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
  .addOperation(Operation.payment({ destination: dest, asset, amount: Number(AMOUNT).toFixed(7) }));
// The memo is how the anchor ties an anonymous ledger payment to our
// withdrawal. Wrong type or missing, and the money arrives unattributed.
if (memo && memoType === "hash") builder.addMemo(Memo.hash(Buffer.from(memo, "base64").toString("hex")));
else if (memo && memoType === "id") builder.addMemo(Memo.id(memo));
else if (memo) builder.addMemo(Memo.text(memo));
const tx = builder.setTimeout(300).build();
tx.sign(treasury);

const submitted = await server.submitTransaction(tx);
say(`PAYMENT SUBMITTED — hash ${submitted.hash}`);
console.log(`      https://stellar.expert/explorer/testnet/tx/${submitted.hash}`);

// --- 5. did the anchor see it? ---------------------------------------------
const final = await waitFor(jwt, wd.id, ["pending_user_transfer_start", "pending_anchor", "pending_external", "incomplete"]);
say(`anchor moved the withdrawal to "${final.status}"`);

const left = await balanceOf(CODE);
say(`treasury ${CODE} ${held} -> ${left} (paid ${(held - left).toFixed(7)})`);

const good = ["completed", "pending_user_transfer_complete"].includes(final.status);
console.log(
  good
    ? `\nSTELLAR PAYOUT LIVE — a real testnet payment reached the anchor and it advanced the withdrawal.`
    : `\nPAYMENT LANDED ON-LEDGER but the anchor sits at "${final.status}". The ledger half is proven; the anchor half is not.`,
);
if (!good) process.exitCode = 1;
