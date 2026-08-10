/**
 * Stellar anchor client — SEP-10 (web auth) + SEP-24 (interactive withdraw).
 *
 * This IS the MoneyGram Ramps protocol: MoneyGram is a Stellar anchor
 * speaking exactly these SEPs from its own home domain, gated on partner
 * onboarding. Pointed at Stellar's public test anchor (testanchor.stellar.org)
 * the same code runs live today with no signup — so the integration is real
 * protocol code, and production MoneyGram is a config change:
 * MG_ANCHOR_DOMAIN + a partner-onboarded account + asset USDC.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";
import { IS_PRODUCTION, ROOT, STELLAR, STELLAR_TESTNET_PASSPHRASE } from "../config.js";

// ---------------------------------------------------------------------------
// Treasury account (auto-provisioned on testnet via friendbot)

const TREASURY_PATH = path.join(ROOT, "data", "stellar-treasury.json");

export async function getTreasury(): Promise<Keypair> {
  if (STELLAR.treasurySecret) return Keypair.fromSecret(STELLAR.treasurySecret);
  if (existsSync(TREASURY_PATH)) {
    if (IS_PRODUCTION) {
      throw new Error("production anchor mode requires STELLAR_TREASURY_SECRET or managed signing, not data/stellar-treasury.json");
    }
    return Keypair.fromSecret(JSON.parse(readFileSync(TREASURY_PATH, "utf8")).secret);
  }
  if (IS_PRODUCTION || STELLAR.networkPassphrase !== STELLAR_TESTNET_PASSPHRASE || !STELLAR.friendbot) {
    throw new Error("refusing to auto-provision a Stellar treasury outside local testnet mode");
  }
  const kp = Keypair.random();
  // Fund on testnet so the account exists on-ledger.
  const res = await fetch(`${STELLAR.friendbot}?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot funding failed (${res.status})`);
  mkdirSync(path.dirname(TREASURY_PATH), { recursive: true });
  writeFileSync(
    TREASURY_PATH,
    JSON.stringify({ publicKey: kp.publicKey(), secret: kp.secret() }, null, 2),
  );
  console.log(`stellar: provisioned treasury ${kp.publicKey()} (friendbot funded)`);
  return kp;
}

// ---------------------------------------------------------------------------
// stellar.toml discovery

export interface AnchorInfo {
  webAuthEndpoint: string;
  transferServerSep24: string;
  signingKey?: string;
  kycServer?: string;
  toml: string;
}

export async function fetchAnchorInfo(homeDomain: string): Promise<AnchorInfo> {
  const res = await fetch(`https://${homeDomain}/.well-known/stellar.toml`);
  if (!res.ok) throw new Error(`stellar.toml fetch failed for ${homeDomain} (${res.status})`);
  const toml = await res.text();
  const get = (key: string) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
  const webAuthEndpoint = get("WEB_AUTH_ENDPOINT");
  const transferServerSep24 = get("TRANSFER_SERVER_SEP0024");
  if (!webAuthEndpoint || !transferServerSep24) {
    throw new Error(`${homeDomain} toml missing WEB_AUTH_ENDPOINT / TRANSFER_SERVER_SEP0024`);
  }
  return {
    webAuthEndpoint,
    transferServerSep24,
    signingKey: get("SIGNING_KEY"),
    kycServer: get("KYC_SERVER"),
    toml,
  };
}

// ---------------------------------------------------------------------------
// SEP-24 /info: what the anchor will actually accept

export interface WithdrawLimits {
  enabled: boolean;
  minAmount?: number;
  maxAmount?: number;
  feeFixed?: number;
  feePercent?: number;
}

/**
 * What the anchor allows for withdrawing `assetCode`. Worth asking before
 * initiating: limits are per-anchor and small on test deployments (Stellar's
 * public test anchor caps withdrawals at 10 units), so a transfer sized for a
 * real corridor will be rejected — better to say so than to open a session
 * the anchor will never honour.
 */
export async function sep24WithdrawLimits(
  homeDomain: string,
  assetCode: string,
): Promise<WithdrawLimits> {
  const info = await fetchAnchorInfo(homeDomain);
  const res = await fetch(`${info.transferServerSep24}/info`);
  if (!res.ok) throw new Error(`SEP-24 info failed (${res.status})`);
  const data = (await res.json()) as { withdraw?: Record<string, any> };
  const entry = data.withdraw?.[assetCode];
  if (!entry) return { enabled: false };
  return {
    enabled: entry.enabled !== false,
    minAmount: entry.min_amount,
    maxAmount: entry.max_amount,
    feeFixed: entry.fee_fixed,
    feePercent: entry.fee_percent,
  };
}

// ---------------------------------------------------------------------------
// SEP-10: challenge -> sign -> JWT
//
// JWTs are cached per (domain, account) until shortly before they expire — a
// pickup used to cost a fresh challenge/sign/exchange round trip every time.

const jwtCache = new Map<string, { token: string; expMs: number }>();

function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export interface Sep10AuthOptions {
  /** SEP-10 custodial auth memo. Must be a positive integer string. */
  memo?: string;
  /**
   * Send `home_domain` on the challenge request.
   *
   * MoneyGram's custodial flow says NOT to: a custodial wallet authenticates
   * with its registered key plus a per-user memo, and passing home_domain is
   * the non-custodial shape. Defaults to omitting it whenever a memo is set,
   * which is exactly the custodial case. Stellar's test anchor accepts either.
   */
  sendHomeDomain?: boolean;
  /** Optional wallet/client domain for SEP-10 client attribution. */
  clientDomain?: string;
  /** Secret for that client domain's SIGNING_KEY, when client attribution is required. */
  clientDomainSigningSecret?: string;
}

function sep10Options(): Sep10AuthOptions {
  return {
    memo: STELLAR.authMemo || undefined,
    clientDomain: STELLAR.clientDomain || undefined,
    clientDomainSigningSecret: STELLAR.clientDomainSigningSecret || undefined,
  };
}

function assertCustodialMemo(memo?: string) {
  if (!memo) return;
  if (!/^[1-9]\d*$/.test(memo)) throw new Error("SEP-10 custodial memo must be a positive integer string");
}

export function validateSep10Challenge(
  challengeXdr: string,
  serverSigningKey: string,
  networkPassphrase: string,
  homeDomain: string,
  webAuthEndpoint: string,
  account: string,
  expectedMemo?: string,
) {
  const { tx, clientAccountID, memo } = WebAuth.readChallengeTx(
    challengeXdr,
    serverSigningKey,
    networkPassphrase,
    homeDomain,
    new URL(webAuthEndpoint).hostname,
  );
  if (clientAccountID !== account) throw new Error(`SEP-10 challenge account mismatch: ${clientAccountID}`);
  if ((expectedMemo ?? null) !== memo) throw new Error("SEP-10 challenge memo mismatch");
  return tx;
}

export async function sep10Auth(
  homeDomain: string,
  keypair: Keypair,
  options: Sep10AuthOptions = sep10Options(),
): Promise<string> {
  const memo = options.memo?.trim();
  assertCustodialMemo(memo);
  const cacheKey = `${homeDomain}:${keypair.publicKey()}:${memo ?? ""}:${options.clientDomain ?? ""}`;
  const hit = jwtCache.get(cacheKey);
  if (hit && Date.now() < hit.expMs - 60_000) return hit.token;
  const token = await sep10Exchange(homeDomain, keypair, { ...options, memo });
  jwtCache.set(cacheKey, { token, expMs: jwtExpiry(token) || Date.now() + 10 * 60_000 });
  return token;
}

async function sep10Exchange(homeDomain: string, keypair: Keypair, options: Sep10AuthOptions): Promise<string> {
  const info = await fetchAnchorInfo(homeDomain);
  if (!info.signingKey) throw new Error(`${homeDomain} toml missing SIGNING_KEY`);
  const url = new URL(info.webAuthEndpoint);
  url.searchParams.set("account", keypair.publicKey());
  // Custodial (memo present) omits home_domain unless explicitly asked for.
  const sendHomeDomain = options.sendHomeDomain ?? !options.memo;
  if (sendHomeDomain) url.searchParams.set("home_domain", homeDomain);
  if (options.memo) url.searchParams.set("memo", options.memo);
  if (options.clientDomain) url.searchParams.set("client_domain", options.clientDomain);
  const chRes = await fetch(url);
  if (!chRes.ok) throw new Error(`SEP-10 challenge failed (${chRes.status}): ${await chRes.text()}`);
  const { transaction, network_passphrase } = (await chRes.json()) as {
    transaction: string;
    network_passphrase?: string;
  };

  if (network_passphrase && network_passphrase !== STELLAR.networkPassphrase) {
    throw new Error(`SEP-10 challenge network mismatch: ${network_passphrase}`);
  }
  const network = STELLAR.networkPassphrase;
  const tx = validateSep10Challenge(
    transaction,
    info.signingKey,
    network,
    homeDomain,
    info.webAuthEndpoint,
    keypair.publicKey(),
    options.memo,
  );
  tx.sign(keypair);
  if (options.clientDomain) {
    if (!options.clientDomainSigningSecret) {
      throw new Error("SEP-10 client_domain requires MG_CLIENT_DOMAIN_SIGNING_SECRET");
    }
    tx.sign(Keypair.fromSecret(options.clientDomainSigningSecret));
  }

  const tokRes = await fetch(info.webAuthEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  if (!tokRes.ok) throw new Error(`SEP-10 token failed (${tokRes.status}): ${await tokRes.text()}`);
  const { token } = (await tokRes.json()) as { token: string };
  return token;
}

// ---------------------------------------------------------------------------
// SEP-12: the KYC / Travel Rule fields the anchor needs about the *sender*
//
// A cash pickup is a money transmission. The anchor pays cash to a person at a
// counter, and its own licence obliges it to know who sent it — the FATF
// Travel Rule originator set (name, date of birth, address, an identity
// document). MoneyGram's production anchor requires these; testanchor declares
// the same SEP-9 catalogue but marks everything optional, which is exactly the
// trap: code that works against the test anchor can be missing every field
// production will demand.
//
// So we ask the anchor what it wants (`sep12CustomerFields`), refuse early if
// we cannot supply it, and PUT it before opening the withdrawal.

/** A SEP-9 field the anchor has declared. */
export interface Sep12Field {
  type?: string;
  description?: string;
  optional?: boolean;
  choices?: string[];
}

export interface Sep12CustomerStatus {
  id?: string;
  status?: string;
  /** Everything the anchor will accept, keyed by SEP-9 field name. */
  fields: Record<string, Sep12Field>;
  /** What it says is still missing for this customer. */
  providedFields: Record<string, Sep12Field>;
}

function kycServerOf(info: AnchorInfo, homeDomain: string): string {
  if (!info.kycServer) {
    throw new Error(`${homeDomain} publishes no KYC_SERVER, so SEP-12 customer data cannot be sent`);
  }
  return info.kycServer;
}

/** Ask the anchor which SEP-9 fields it wants for this account. */
export async function sep12CustomerFields(
  homeDomain: string,
  jwt: string,
  account: string,
  type = "sep24-customer",
  memo?: string,
): Promise<Sep12CustomerStatus> {
  const info = await fetchAnchorInfo(homeDomain);
  const url = new URL(`${kycServerOf(info, homeDomain)}/customer`);
  url.searchParams.set("account", account);
  if (type) url.searchParams.set("type", type);
  // Custodial wallets share one Stellar account, so the memo is what makes
  // each user a distinct customer at the anchor. Without it every user would
  // inherit whoever's KYC was submitted first.
  if (memo) {
    url.searchParams.set("memo", memo);
    url.searchParams.set("memo_type", "id");
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) throw new Error(`SEP-12 GET /customer failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as any;
  return {
    id: data.id,
    status: data.status,
    fields: data.fields ?? {},
    providedFields: data.provided_fields ?? {},
  };
}

/**
 * Which of the anchor's REQUIRED fields we cannot supply.
 *
 * Returned rather than thrown so the caller can decide: refusing to open a
 * withdrawal is right at payout time, but the same answer is useful for
 * telling a user up front what their profile is missing.
 */
export function missingRequiredFields(
  declared: Record<string, Sep12Field>,
  supplied: Record<string, string | undefined>,
): string[] {
  return Object.entries(declared)
    .filter(([name, spec]) => spec.optional !== true && !supplied[name])
    .map(([name]) => name);
}

/**
 * Send the customer's SEP-9 fields. Binary fields (photo ID, proof of
 * residence) would need multipart; we deliberately send only the text set —
 * document images belong with a KYC provider, not in this app's store.
 */
export async function sep12PutCustomer(
  homeDomain: string,
  jwt: string,
  account: string,
  fields: Record<string, string | undefined>,
  type = "sep24-customer",
  memo?: string,
): Promise<{ id?: string; status?: string }> {
  const info = await fetchAnchorInfo(homeDomain);
  const body: Record<string, string> = { account };
  if (type) body.type = type;
  if (memo) {
    body.memo = memo;
    body.memo_type = "id";
  }
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string" && v.trim() !== "") body[k] = v.trim();
  }
  const res = await fetch(`${kycServerOf(info, homeDomain)}/customer`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`SEP-12 PUT /customer failed (${res.status}): ${await res.text()}`);
  const data = (await res.json().catch(() => ({}))) as any;
  return { id: data.id, status: data.status };
}

// ---------------------------------------------------------------------------
// SEP-24: interactive withdrawal

export interface Sep24Withdrawal {
  id: string;
  url: string; // interactive KYC/details page (recipient-facing at MoneyGram)
  status?: string;
}

export async function sep24InitiateWithdraw(
  homeDomain: string,
  jwt: string,
  assetCode: string,
  account: string,
  amount?: string,
  /**
   * SEP-9 customer fields. MoneyGram reads them here, in the interactive POST
   * body — not over SEP-12 — so a withdrawal that omits them makes the user
   * re-enter everything in the webview. Anchors ignore fields they don't know.
   */
  sep9Fields?: Record<string, string>,
): Promise<Sep24Withdrawal> {
  const info = await fetchAnchorInfo(homeDomain);
  const res = await fetch(`${info.transferServerSep24}/transactions/withdraw/interactive`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      asset_code: assetCode,
      account,
      ...(amount ? { amount } : {}),
      ...(sep9Fields ?? {}),
    }),
  });
  if (!res.ok) throw new Error(`SEP-24 withdraw failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { id: string; url: string; type: string };
  return { id: data.id, url: data.url };
}

export interface Sep24Status {
  id: string;
  status: string;
  amountIn?: string;
  withdrawAnchorAccount?: string;
  withdrawMemo?: string;
  withdrawMemoType?: string;
  externalTransactionId?: string;
  moreInfoUrl?: string;
}

export async function sep24GetTransaction(
  homeDomain: string,
  jwt: string,
  id: string,
): Promise<Sep24Status> {
  const info = await fetchAnchorInfo(homeDomain);
  const res = await fetch(`${info.transferServerSep24}/transaction?id=${id}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`SEP-24 status failed (${res.status}): ${await res.text()}`);
  const { transaction: t } = (await res.json()) as { transaction: any };
  return {
    id: t.id,
    status: t.status,
    amountIn: t.amount_in,
    withdrawAnchorAccount: t.withdraw_anchor_account,
    withdrawMemo: t.withdraw_memo,
    withdrawMemoType: t.withdraw_memo_type,
    externalTransactionId: t.external_transaction_id,
    moreInfoUrl: t.more_info_url,
  };
}


// ---------------------------------------------------------------------------
// Trustlines and reserves
//
// Stellar will not let an account receive an asset it does not trust, so a
// bridge delivery or an anchor refund lands nowhere without a trustline first. Each
// trustline also locks 0.5 XLM of reserve (base reserve, read live below), and
// the account itself needs 2 base reserves, so an account holding one asset
// needs ~1.5 XLM locked plus fees.
//
// MoneyGram's own guide is the same three steps: fund the account with XLM,
// add the USDC trustline, then acquire USDC.

/** 1 XLM in stroops. */
const STROOPS = 10_000_000;

export interface AccountReserves {
  balanceXlm: number;
  /** Locked by the account plus its entries — cannot be spent. */
  minimumXlm: number;
  spendableXlm: number;
  subentries: number;
}

/** Live base reserve, rather than a hardcoded 0.5 that a protocol change breaks. */
export async function baseReserveXlm(): Promise<number> {
  const res = await fetch(`${STELLAR.horizon}/ledgers?order=desc&limit=1`);
  if (!res.ok) throw new Error(`Horizon ledgers failed (${res.status})`);
  const rec = (await res.json()) as any;
  const stroops = rec?._embedded?.records?.[0]?.base_reserve_in_stroops;
  return typeof stroops === "number" ? stroops / STROOPS : 0.5;
}

/** Does `account` already trust `asset`, and can it hold more of it? */
export async function hasTrustline(account: string, asset: Asset): Promise<boolean> {
  if (asset.isNative()) return true;
  const server = new Horizon.Server(STELLAR.horizon);
  const loaded = await server.loadAccount(account);
  return loaded.balances.some(
    (b: any) =>
      b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
}

/** What the account holds, and how much of it is locked as reserve. */
export async function accountReserves(account: string): Promise<AccountReserves> {
  const server = new Horizon.Server(STELLAR.horizon);
  const loaded = await server.loadAccount(account);
  const native = loaded.balances.find((b: any) => b.asset_type === "native") as any;
  const balanceXlm = Number(native?.balance ?? 0);
  const base = await baseReserveXlm();
  const subentries = (loaded as any).subentry_count ?? 0;
  const minimumXlm = (2 + subentries) * base;
  return {
    balanceXlm,
    minimumXlm,
    spendableXlm: Math.max(0, balanceXlm - minimumXlm),
    subentries,
  };
}

/**
 * Establish a trustline if it is missing. Returns what happened, so a caller
 * can report "already trusted" differently from "just created".
 *
 * Refuses rather than submitting a transaction that would fail when the
 * account cannot cover the extra reserve — the error names the shortfall.
 */
export async function ensureTrustline(
  keypair: Keypair,
  asset: Asset,
): Promise<{ created: boolean; hash?: string; reserves: AccountReserves }> {
  if (asset.isNative()) {
    return { created: false, reserves: await accountReserves(keypair.publicKey()) };
  }
  if (await hasTrustline(keypair.publicKey(), asset)) {
    return { created: false, reserves: await accountReserves(keypair.publicKey()) };
  }

  const base = await baseReserveXlm();
  const before = await accountReserves(keypair.publicKey());
  if (before.spendableXlm < base) {
    throw new Error(
      `${keypair.publicKey()} cannot afford a ${asset.getCode()} trustline: ` +
        `needs ${base} XLM of reserve but only ${before.spendableXlm.toFixed(4)} XLM is spendable ` +
        `(balance ${before.balanceXlm}, ${before.minimumXlm} locked)`,
    );
  }

  const server = new Horizon.Server(STELLAR.horizon);
  const account = await server.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR.networkPassphrase || Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(180)
    .build();
  tx.sign(keypair);
  const submitted = await server.submitTransaction(tx);
  return {
    created: true,
    hash: submitted.hash,
    reserves: await accountReserves(keypair.publicKey()),
  };
}

/**
 * Drop a trustline, returning its reserve. Only succeeds on a zero balance,
 * which Stellar enforces — you cannot abandon an asset you still hold.
 */
export async function removeTrustline(keypair: Keypair, asset: Asset): Promise<boolean> {
  if (asset.isNative()) return false;
  if (!(await hasTrustline(keypair.publicKey(), asset))) return false;
  const server = new Horizon.Server(STELLAR.horizon);
  const account = await server.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR.networkPassphrase || Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset, limit: "0" }))
    .setTimeout(180)
    .build();
  tx.sign(keypair);
  await server.submitTransaction(tx);
  return true;
}

/**
 * Can this account actually receive the anchor's asset right now?
 *
 * Meant as a pre-flight: a bridge transfer delivered to an account with no
 * trustline destroys USDC on the source chain and delivers nothing, so the
 * cheap check belongs before the irreversible step.
 */
export async function anchorPayoutReadiness(
  homeDomain: string,
  assetCode: string,
  account: string,
): Promise<{ ready: boolean; asset: string; issuer?: string; problems: string[] }> {
  const problems: string[] = [];
  const asset = await stellarAssetForAnchor(homeDomain, assetCode);
  let reserves: AccountReserves | undefined;
  try {
    reserves = await accountReserves(account);
  } catch {
    problems.push(`${account} does not exist on this network — fund it with XLM first`);
  }
  if (reserves) {
    if (!(await hasTrustline(account, asset))) {
      problems.push(
        `${account} has no ${asset.getCode()} trustline, so it cannot receive the anchor's asset`,
      );
    }
    const base = await baseReserveXlm().catch(() => 0.5);
    if (reserves.spendableXlm < base) {
      problems.push(
        `${account} has only ${reserves.spendableXlm.toFixed(4)} XLM spendable — too little for reserves and fees`,
      );
    }
  }
  return {
    ready: problems.length === 0,
    asset: asset.isNative() ? "native" : asset.getCode(),
    issuer: asset.isNative() ? undefined : asset.getIssuer(),
    problems,
  };
}

// ---------------------------------------------------------------------------
// SEP-24 on-ledger payment: send the withdrawn asset to the anchor account.

function currencyBlock(toml: string, assetCode: string): string | undefined {
  return toml
    .split("[[CURRENCIES]]")
    .slice(1)
    .find((block) => block.match(/^code\s*=\s*"([^"]+)"/m)?.[1] === assetCode);
}

export async function stellarAssetForAnchor(
  homeDomain: string,
  assetCode: string,
): Promise<Asset> {
  if (assetCode === "native" || assetCode === "XLM") return Asset.native();
  const info = await fetchAnchorInfo(homeDomain);
  const block = currencyBlock(info.toml, assetCode);
  const issuer = block?.match(/^issuer\s*=\s*"([^"]+)"/m)?.[1];
  if (!issuer) throw new Error(`${homeDomain} toml missing issuer for ${assetCode}`);
  return new Asset(assetCode, issuer);
}

function sep24Memo(status: Sep24Status) {
  const value = status.withdrawMemo;
  const type = status.withdrawMemoType ?? "";
  if (!value) return Memo.none();
  if (type === "text") return Memo.text(value);
  if (type === "id") return Memo.id(value);
  if (type === "hash") return Memo.hash(value);
  if (type === "return") return Memo.return(value);
  throw new Error(`unsupported SEP-24 withdraw memo type: ${type}`);
}

function stellarAmount(amount: number): string {
  if (!(amount > 0)) throw new Error("payment amount must be positive");
  return amount.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
}

/** Stellar's smallest unit — the only difference we tolerate as rounding. */
const STROOP = 1e-7;

/**
 * Decide what to actually pay the anchor.
 *
 * The anchor echoes `amount_in` once the session firms up, and it is tempting
 * to just send that. But it is a remote-supplied number driving an outbound
 * payment, and we already validated `requested` against the anchor's own
 * published limits — so an `amount_in` that disagrees is a disagreement to
 * surface, not to silently honour. We never send more than we intended to.
 */
export function resolvePaymentAmount(requested: number, amountIn?: string): number {
  if (!(requested > 0)) throw new Error("payment amount must be positive");
  if (amountIn === undefined || amountIn === null || amountIn === "") return requested;
  const echoed = Number(amountIn);
  if (!Number.isFinite(echoed) || echoed <= 0) {
    throw new Error(`anchor reported an unusable amount_in (${amountIn})`);
  }
  if (echoed > requested + STROOP) {
    throw new Error(
      `anchor asked for ${echoed} but the withdrawal was opened for ${requested} — ` +
        `refusing to send more than we authorised`,
    );
  }
  // Anchor asking for less (fees taken on their side) is theirs to decide.
  return echoed;
}

/**
 * Thrown when a payment may or may not have reached the network — a submit
 * that timed out, or a Horizon response we could not interpret. The caller
 * must NOT auto-refund on this: the money may be gone.
 */
export class AnchorPaymentUncertainError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AnchorPaymentUncertainError";
  }
}

export interface Sep24PaymentResult {
  hash: string;
  destination: string;
  memo?: string;
  memoType?: string;
  assetCode: string;
  amount: string;
}

export async function sendSep24WithdrawalPayment(
  homeDomain: string,
  jwt: string,
  id: string,
  source: Keypair,
  assetCode: string,
  amount: number,
): Promise<Sep24PaymentResult> {
  const status = await sep24GetTransaction(homeDomain, jwt, id);
  if (!status.withdrawAnchorAccount) {
    throw new Error(`SEP-24 transaction ${id} has not provided a withdrawal account yet`);
  }
  const server = new Horizon.Server(STELLAR.horizon);
  const account = await server.loadAccount(source.publicKey());
  const asset = await stellarAssetForAnchor(homeDomain, assetCode);
  // Never send more than the withdrawal we opened and validated against the
  // anchor's published limits, whatever amount_in says.
  const paymentAmount = stellarAmount(resolvePaymentAmount(amount, status.amountIn));
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR.networkPassphrase || Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: status.withdrawAnchorAccount,
        asset,
        amount: paymentAmount,
      }),
    )
    .addMemo(sep24Memo(status))
    .setTimeout(300)
    .build();
  tx.sign(source);

  // Everything above this line is safe to retry: nothing has been broadcast.
  // Past it, a failure is ambiguous — a timeout can still land on-ledger — so
  // the error type tells the caller not to refund on the assumption it didn't.
  let submitted;
  try {
    submitted = await server.submitTransaction(tx);
  } catch (err: any) {
    throw new AnchorPaymentUncertainError(
      `Stellar payment to ${status.withdrawAnchorAccount} may or may not have landed: ${
        err?.message ?? err
      }`,
      err,
    );
  }
  if (!submitted?.hash) {
    throw new AnchorPaymentUncertainError(
      `Stellar payment to ${status.withdrawAnchorAccount} returned no transaction hash`,
    );
  }
  return {
    hash: submitted.hash,
    destination: status.withdrawAnchorAccount,
    memo: status.withdrawMemo,
    memoType: status.withdrawMemoType,
    assetCode,
    amount: paymentAmount,
  };
}
