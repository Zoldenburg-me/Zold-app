import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { IS_PRODUCTION, ROOT } from "./config.js";

export type KycStatus = "pending" | "approved" | "rejected" | "manual_review";

export interface User {
  id: string;
  name: string;
  email?: string;
  country: string;
  kycStatus: KycStatus;
  kyc?: {
    provider: "mock" | "manual" | "monerium";
    onboardingPath?: "existing_monerium" | "new_monerium";
    applicantId?: string;
    checkedAt?: string;
    reason?: string;
  };
  /**
   * FATF Travel Rule originator data — who is sending the money.
   *
   * A cash pickup is a money transmission: the anchor pays a stranger at a
   * counter and its licence obliges it to know who funded that. MoneyGram's
   * anchor requires these as SEP-9 fields before a withdrawal can complete;
   * without them a SEP-12 customer sits at NEEDS_INFO.
   *
   * PII WARNING: this store is plaintext JSON on disk (see `db.json`), so a
   * real deployment must move these into whatever holds the KYC record —
   * ideally the provider keeps them and this app holds only a reference.
   * Document images are deliberately NOT accepted here; they belong with the
   * KYC provider, not in this file.
   */
  senderProfile?: {
    firstName: string;
    lastName: string;
    birthDate?: string; // ISO yyyy-mm-dd
    address?: string;
    city?: string;
    postalCode?: string;
    stateOrProvince?: string;
    addressCountryCode?: string; // ISO 3166-1 alpha-2
    idType?: "passport" | "drivers_license" | "id_card";
    idNumber?: string;
    idCountryCode?: string;
    mobileNumber?: string;
    emailAddress?: string;
    occupation?: string;
    updatedAt?: string;
  };
  iban: string; // funding IBAN — mock-issued, or real from Monerium sandbox
  /** Candide Safe smart-account address — the user's identity and balance
   *  account, and the address Monerium attaches the IBAN to. */
  address: `0x${string}`;
  ownerAddress?: `0x${string}`; // EOA owner (signer) of the Safe
  /** Owner key of the Safe. MVP-grade custody: needed to sign Monerium's
   *  ownership declaration and UserOperations. Production: KMS/passkeys. */
  privateKey?: `0x${string}`;
  /** FP4: the device key allowed to authorize debits from this account. We
   *  store only its address — the private half stays in the user's browser. */
  authorizerAddress?: `0x${string}`;
  wallet?: { type: "candide-safe"; deployed: boolean; deployOpHash?: string };
  /**
   * Passkey Safe state. Production can add a co-signer as a second owner;
   * local/test plans stay passkey-only unless the harness opts in.
   */
  passkeySafe?: {
    address: `0x${string}`;
    status: "planned" | "active";
    threshold: 1 | 2;
    cosignerAddress?: `0x${string}`;
    passkeyPublicKey: { x: string; y: string };
    cosignerPolicy?: {
      enabled: boolean;
      allowanceModuleAddress: `0x${string}`;
      allowanceAmount: string;
    };
    recovery?: {
      moduleAddress: `0x${string}`;
      guardianAddress: `0x${string}`;
      threshold: 1;
      status: "planned" | "active";
      enabledAt?: string;
    };
    createdAt: string;
    previousAddress?: `0x${string}`;
  };
  /** WebAuthn credential bound to this account. Public key + counter are
   *  stored from a verified registration; login verifies assertions. */
  passkey?: {
    credentialId: string;
    publicKey?: { jwk: JsonWebKey; alg: "ES256" | "RS256" };
    signCount?: number;
    rpId?: string;
    attestation?: string;
    createdAt: string;
  };
  /**
   * Public payment page, e.g. `alice` serving /pay/alice.
   *
   * A payment page has its own deposit address. It must not point at the
   * user's main account: the settlement rule belongs to the page, and generic
   * transfers into the user's wallet must not be swept or converted just
   * because a public payment link exists.
   */
  paymentPage?: {
    handle: string;
    displayName?: string;
    depositAddress: `0x${string}`;
    /**
     * MVP deposit key for the page address. This is a custody boundary, so it
     * is stripped from every API response and forbidden in production stores.
     */
    depositPrivateKey?: `0x${string}`;
    settlementAsset: "EURE" | "USDC";
    autoConvert: boolean;
    createdAt: string;
    updatedAt: string;
  };
  /** Legacy payment-page fields. Kept only so existing local db.json files can
   *  migrate lazily the next time the handle is saved. New code reads
   *  paymentPage instead. */
  handle?: string;
  payDisplayName?: string;
  autoConvert?: boolean;
  /** mock: IBAN issued locally. sandbox states track Monerium provisioning. */
  funding?: {
    mode: "mock" | "sandbox";
    status: "kyc_pending" | "active" | "provisioning" | "iban_pending" | "error";
    moneriumProfileId?: string;
    detail?: string;
  };
  /** Per-user Monerium OAuth connect state. Tokens are encrypted at rest and
   *  never returned by the API. */
  moneriumConnect?: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    createdAt: string;
  };
  monerium?: {
    connectedAt: string;
    profileId?: string;
    accessTokenEnc?: string;
    refreshTokenEnc?: string;
    expiresAt?: string;
    profiles?: any[];
    ibans?: any[];
    addresses?: any[];
  };
  privacyBundle?: {
    planId: string;
    status: "active" | "pending_fulfillment" | "canceled";
    startedAt: string;
    renewsAt: string;
    canceledAt?: string;
    esim?: {
      provider: "kokio";
      status: "pending" | "active" | "unavailable";
      dataGb: number;
      region: string;
    };
    vpn?: {
      provider: "mysterium";
      status: "pending" | "active" | "unavailable";
      bandwidthGb: number;
      devices: number;
    };
    usage: {
      esimGb: number;
      vpnGb: number;
      periodStartedAt: string;
    };
  };
  createdAt: string;
}

export type PayoutRail = "cash" | "sepa" | "upi";

export interface Quote {
  id: string;
  userId: string;
  rail: PayoutRail;
  status: "OPEN" | "CONSUMED" | "EXPIRED";
  sendEur: number;
  fixedFeeEur: number;
  fxRate: number; // all-in rate after spread (EUR->KES, 1 for sepa, EUR->INR)
  receiveKes: number; // cash rail (0 otherwise)
  receiveEur: number; // sepa rail (0 otherwise)
  receiveInr: number; // upi rail (0 otherwise) — INR-fixed: this drives sendEur
  /** True market mid from the live feed. A reference we do NOT trade at. */
  midRate: number;
  /** Measured gap between midRate and fxRate. Not a configured constant: the
   *  receipt used to assert a flat 0.50% while the mid was a stale hardcoded
   *  number, so the stated margin and the real one were unrelated. */
  marginBps: number;
  /** What the sender really gets per EUR sent, fixed fee included. At small
   *  amounts the flat fee dominates (EUR 1 on UPI loses 29% to it), and an
   *  itemised fee alone made that look like a broken exchange rate. */
  effectiveRate: number;
  /** FP5: the on-chain FxSwapper rate (tokenOut units per 1e18 tokenIn) this
   *  quote's economics assume. Execution refuses to swap if the live rate has
   *  drifted past tolerance — binds quoted price to settlement price. */
  lockedSwapRate?: string;
  expiresAt: string;
  createdAt: string;
}

export type TransferState =
  | "CREATED"
  | "DEBITED"
  | "SWAPPED"
  | "BRIDGED"
  | "PAYOUT_DETAILS_PENDING"
  | "PAYOUT_FUNDING_PENDING"
  | "PAYOUT_FUNDED"
  | "PAYOUT_READY"
  | "PAYOUT_SUBMITTED"
  | "PAID"
  | "MANUAL_REVIEW"
  | "FAILED"
  | "REFUNDED";

/**
 * One inbound crypto transfer seen at a user's account.
 *
 * Recorded BEFORE anything is moved or credited, so a crash between detection
 * and conversion leaves a record to resume from rather than a deposit nobody
 * knows arrived. `txHash` + `logIndex` is the natural identity of an ERC-20
 * transfer and is what makes reprocessing a no-op.
 *
 * REFUSED is a resting state, not a failure to retry: the euros were never
 * credited and the tokens are still the user's, sitting where they landed.
 */
export interface CryptoDeposit {
  id: string;
  userId: string;
  chainId: number;
  token: "USDC";
  txHash: string;
  logIndex: number;
  /** Raw token units (USDC is 6dp), as a string — JSON has no bigint. */
  amountUnits: string;
  amountUsdc: number;
  state: "DETECTED" | "CONVERTED" | "REFUSED";
  /** Why it was refused, in words a support person can act on. */
  reason?: string;
  creditedEur?: number;
  creditedUsdc?: number;
  settlementAsset?: "EURE" | "USDC";
  paymentAddress?: `0x${string}`;
  /** The venue that filled it and the rate it filled at, for the receipt. */
  provider?: string;
  rate?: number;
  txs: { step: string; hash: string }[];
  detectedAt: string;
  updatedAt: string;
}

export interface Transfer {
  id: string;
  userId: string;
  quoteId: string;
  rail: PayoutRail;
  recipientName: string;
  recipientPhone?: string; // cash rail
  recipientIban?: string; // sepa rail
  recipientVpa?: string; // upi rail (merchant/recipient UPI ID)
  /**
   * Payer-supplied remittance reference, carried to the payee on the SEPA
   * payment so they can reconcile it against their own records. Set by callers
   * that pay a third party on someone's behalf — the "Pay with Zold" checkout
   * puts the merchant's own user/transaction handle here. Free text, and it
   * reaches a bank statement, so it is normalised at send (see sepa.ts).
   */
  reference?: string;
  state: TransferState;
  sendEur: number;
  receiveKes: number; // cash rail
  receiveEur?: number; // sepa rail
  receiveInr?: number; // upi rail
  usdcOut?: number;
  /**
   * Where the input EURe is taken from at execution time.
   *
   * Safe is the only live funding source now. The API verifies the device
   * authorization before moving the one-time amount needed for this rail:
   * the full send on the FX rails, the fee alone on SEPA.
   */
  fundingSource?: "safe";
  /** FP4: the terms the device is asked to authorize. Fixed when the transfer
   *  is created so the signature covers exactly what gets submitted; the
   *  transfer cannot leave CREATED until a matching signature arrives. */
  auth?: {
    to: `0x${string}`;
    amountWei: string; // bigint as decimal string (JSON store)
    /** keccak256 commitment to the payout destination (rail + IBAN/VPA/phone),
     *  signed by the device so the recipient cannot be swapped after signing. */
    destination: `0x${string}`;
    deadline: number; // unix seconds
    authorizedAt?: string;
  };
  /**
   * Monerium redeem approval fixed at transfer creation for SEPA payouts.
   * Once the Safe is passkey/co-signer owned, the browser must sign this while
   * the user is present; the server can then submit the redeem later without a
   * database Safe owner key.
   */
  moneriumRedeem?: {
    amount: string;
    iban: string;
    issuedAt: string;
    message: string;
    memo?: string;
    signature?: `0x${string}`;
    signedAt?: string;
  };
  txs: { step: string; hash: string }[];
  /** Internal JIT liquidity execution details. This records how value moved
   *  into the settlement asset for the payout rail; it is not a swap product. */
  liquidity?: {
    provider: "fx-swapper" | "rfq" | "cow" | "dex" | "lifi" | "best";
    side: "EURE_TO_USDC" | "USDC_TO_EURE";
    quoteId: string;
    tokenIn: "EURe" | "USDC";
    tokenOut: "EURe" | "USDC";
    amountIn: string;
    expectedOut: string;
    minOut: string;
    rate: string;
    expiresAt: string;
    /** RFQ only: the maker's quote id and the tx it wants submitted. Persisted
     *  because the plan is prepared and executed in separate steps — a quote
     *  that lost its tx cannot be replayed, and re-quoting at execution time
     *  would settle at a price the user never agreed to. */
    rfq?: { quoteId: string; tx: { to?: string; data?: string; value?: string } | null; approvalTarget?: string };
    executedAt?: string;
    txHash?: string;
  };
  pickup?: {
    referenceCode: string;
    provider: string;
    status: string;
    /** SEP-24 interactive URL (recipient-facing page at the anchor). */
    interactiveUrl?: string;
    /** Anchor mode: the anchor's own ids/amounts, and the last status it
     *  reported. `referenceCode` is ours; a real MoneyGram agent code is
     *  theirs. Keeping both stops one being mistaken for the other. */
    anchorTransactionId?: string;
    anchorAmount?: number;
    anchorAsset?: string;
    anchorPaymentHash?: string;
    /** SEP-10 memo used when the anchor withdrawal was created. Reused on
     *  refresh/funding so custodial anchors keep the same per-user context. */
    anchorMemo?: string;
    anchorAmountIn?: string;
    anchorReferenceNumber?: string;
    moreInfoUrl?: string;
    anchorStatus?: string;
  };
  /** SEPA payout leg: a real Monerium redeem order in sandbox, or a mock. */
  sepa?: { mode: "sandbox" | "mock"; orderId?: string; state: string; detail?: string };
  /** UPI payout leg (mock partner): UTR is the bank-side reference. */
  upi?: { provider: string; utr: string; state: string };
  error?: string;
  /** FP3: automated compensation after failure. Refund amount depends on
   *  which step failed — costs incurred up to that point are itemized. */
  refund?: {
    amountEur: number;
    recoveredFrom: string; // furthest completed step
    deductions: string;
    at: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type RecoveryRequestStatus =
  | "KYC_PENDING"
  | "DELAYING"
  | "READY_FOR_GUARDIAN"
  | "GUARDIAN_SUBMITTED"
  | "FINALIZED"
  | "CANCELED"
  | "EXPIRED";

export interface RecoveryRequest {
  id: string;
  userId: string;
  safeAddress: `0x${string}`;
  status: RecoveryRequestStatus;
  requestedAt: string;
  expiresAt: string;
  recoveryDelayHours: number;
  guardianAddress: `0x${string}`;
  recoveryModuleAddress: `0x${string}`;
  /** New owner after recovery. A future passkey recovery flow can derive this
   *  from WebAuthn coordinates; the API accepts an address for operator pilots. */
  newOwnerAddress?: `0x${string}`;
  contact?: string;
  kycApprovedAt?: string;
  readyAt?: string;
  finalizedAt?: string;
  canceledAt?: string;
  reviewedBy?: string;
  reviewReason?: string;
  cancelReason?: string;
  guardianSubmission?: {
    mode: "external_signer";
    requestedAt: string;
    submittedAt?: string;
    signerStatus?: string;
    txHash?: `0x${string}`;
    error?: string;
  };
  factors: {
    kyc: "pending" | "passed" | "failed";
    otp: "pending" | "passed" | "failed";
    liveness: "pending" | "passed" | "failed";
    manualReview: "pending" | "passed" | "failed";
  };
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt?: string;
}


interface Db {
  users: User[];
  quotes: Quote[];
  transfers: Transfer[];
  sessions: Session[];
  /** Monerium issue-order ids already reflected in local receipt state. */
  processedMoneriumOrders: string[];
  /** Monerium webhook delivery ids already accepted. */
  processedMoneriumWebhooks: string[];
  /** Inbound crypto seen at a user's account, and what became of it. */
  cryptoDeposits: CryptoDeposit[];
  /** Managed KYC guardian recovery requests. */
  recoveryRequests: RecoveryRequest[];
  /**
   * Last block scanned for inbound crypto, per chain id.
   *
   * Kept as a string because JSON has no bigint. Per chain because
   * deployments.json is too: a testnet cursor must not be read as a local one
   * and skip every block on a fresh chain.
   */
  cryptoDepositCursor: Record<string, string>;
}

/**
 * Where the store lives. TRANSF_DB_PATH overrides it.
 *
 * Tests point this somewhere disposable, because they reset the database on
 * every run — and when that was the same file the running app uses, a test
 * run destroyed live accounts. That is not hypothetical: it wiped a Safe
 * owner key on Base Sepolia, stranding the account permanently, since only
 * the current authorizer may rotate. A test must not be able to reach the
 * working database at all.
 */
const DB_PATH = process.env.TRANSF_DB_PATH
  ? path.resolve(process.env.TRANSF_DB_PATH)
  : path.join(ROOT, "data", "db.json");
const DATA_DIR = path.dirname(DB_PATH);

let db: Db = {
  users: [],
  quotes: [],
  transfers: [],
  sessions: [],
  processedMoneriumOrders: [],
  processedMoneriumWebhooks: [],
  cryptoDeposits: [],
  recoveryRequests: [],
  cryptoDepositCursor: {},
};

export function initStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(DB_PATH)) {
    db = JSON.parse(readFileSync(DB_PATH, "utf8"));
    db.sessions ??= [];
    db.processedMoneriumOrders ??= [];
    db.processedMoneriumWebhooks ??= [];
    db.cryptoDeposits ??= [];
    db.recoveryRequests ??= [];
    db.cryptoDepositCursor ??= {};
    if (IS_PRODUCTION) {
      const custodial = db.users.filter((u) => u.privateKey || u.ownerAddress || u.paymentPage?.depositPrivateKey);
      if (custodial.length) {
        throw new Error(
          `production store contains ${custodial.length} account(s) with API-held Safe owner material; ` +
            "activate passkey/co-signer Safes and non-custodial payment pages before startup",
        );
      }
    }
    for (const q of db.quotes) q.status ??= "OPEN";
    for (const s of db.sessions) s.expiresAt ??= new Date(Date.parse(s.createdAt) + 24 * 60 * 60 * 1000).toISOString();
    pruneSessions();
    persist();
  } else {
    persist();
  }
}

/**
 * Drop sessions that can no longer authenticate anything. They were kept
 * forever, so every request paid for them twice: a linear scan to find the live
 * one, and a full re-serialisation of the file on write.
 */
function pruneSessions(retainMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - retainMs;
  db.sessions = db.sessions.filter((s) => {
    const dead = s.revokedAt ? Date.parse(s.revokedAt) : Date.parse(s.expiresAt);
    return !(Number.isFinite(dead) && dead < cutoff);
  });
}

function persist() {
  const tmp = DB_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_PATH);
}

export const store = {
  get users() {
    return db.users;
  },
  get quotes() {
    return db.quotes;
  },
  get transfers() {
    return db.transfers;
  },
  get sessions() {
    return db.sessions;
  },
  get recoveryRequests() {
    return db.recoveryRequests;
  },
  addUser(u: User) {
    db.users.push(u);
    persist();
  },
  updateUser(id: string, patch: Partial<User>) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    Object.assign(u, patch);
    persist();
    return u;
  },
  addRecoveryRequest(r: RecoveryRequest) {
    db.recoveryRequests.push(r);
    persist();
  },
  updateRecoveryRequest(id: string, patch: Partial<RecoveryRequest>) {
    const r = db.recoveryRequests.find((x) => x.id === id);
    if (!r) throw new Error(`unknown recovery request ${id}`);
    Object.assign(r, patch);
    persist();
    return r;
  },
  findRecoveryRequest(id: string) {
    return db.recoveryRequests.find((r) => r.id === id);
  },
  recoveryRequestsForUser(userId: string) {
    return db.recoveryRequests.filter((r) => r.userId === userId);
  },
  findUserByAddress(address: string) {
    return db.users.find((u) => u.address.toLowerCase() === address.toLowerCase());
  },
  findUserByCredential(credentialId: string) {
    return db.users.find((u) => u.passkey?.credentialId === credentialId);
  },
  /** Every Monerium order id we have reflected in local receipt state. */
  mirroredOrderIds(): string[] {
    return [...db.processedMoneriumOrders];
  },
  isOrderProcessed(orderId: string) {
    return db.processedMoneriumOrders.includes(orderId);
  },
  markOrderProcessed(orderId: string) {
    db.processedMoneriumOrders.push(orderId);
    persist();
  },
  isWebhookProcessed(webhookId: string) {
    return db.processedMoneriumWebhooks.includes(webhookId);
  },
  markWebhookProcessed(webhookId: string) {
    db.processedMoneriumWebhooks.push(webhookId);
    persist();
  },
  addQuote(q: Quote) {
    db.quotes.push(q);
    persist();
  },
  updateQuote(id: string, patch: Partial<Quote>) {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) throw new Error(`unknown quote ${id}`);
    Object.assign(q, patch);
    persist();
    return q;
  },
  consumeQuote(id: string) {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) throw new Error(`unknown quote ${id}`);
    if ((q.status ?? "OPEN") !== "OPEN") return false;
    q.status = "CONSUMED";
    persist();
    return true;
  },
  addTransfer(t: Transfer) {
    db.transfers.push(t);
    persist();
  },
  /**
   * Claim the one and only authorization submission for a transfer.
   *
   * Deliberately synchronous: an Express handler runs uninterrupted until its
   * first `await`, so claiming here — before any chain call — is what makes two
   * concurrent submissions of the same device signature impossible. Without it
   * both passed the `state === "CREATED"` check and both could have submitted
   * the same Safe spend. One claim must win before any chain call starts.
   *
   * Returns false when the transfer is not awaiting authorization, has no terms,
   * or has already been claimed.
   */
  claimAuthorization(id: string) {
    const t = db.transfers.find((x) => x.id === id);
    if (!t || t.state !== "CREATED" || !t.auth || t.auth.authorizedAt) return false;
    const now = new Date().toISOString();
    t.auth.authorizedAt = now;
    t.updatedAt = now;
    persist();
    return true;
  },
  updateTransfer(id: string, patch: Partial<Transfer>) {
    const t = db.transfers.find((x) => x.id === id);
    if (!t) throw new Error(`unknown transfer ${id}`);
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    persist();
    return t;
  },
  addSession(s: Session) {
    pruneSessions();
    db.sessions.push(s);
    persist();
  },
  findSessionByTokenHash(tokenHash: string) {
    return db.sessions.find((s) => s.tokenHash === tokenHash);
  },
  revokeSession(id: string) {
    const s = db.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown session ${id}`);
    s.revokedAt = new Date().toISOString();
    persist();
    return s;
  },
  touchSession(id: string) {
    const s = db.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown session ${id}`);
    // lastUsedAt is telemetry, not a security control. Writing it on every
    // authenticated request re-serialised the entire store per call, which grows
    // with the number of users and transfers — a self-amplifying cost. Minute
    // granularity is enough to see an idle session.
    const now = Date.now();
    if (now - Date.parse(s.lastUsedAt) < 60_000) return s;
    s.lastUsedAt = new Date(now).toISOString();
    persist();
    return s;
  },
  /** Handles are compared case-insensitively; they are stored lowercase. */
  findUserByHandle(handle: string) {
    const h = handle.trim().toLowerCase();
    return db.users.find((u) => (u.paymentPage?.handle ?? u.handle) === h);
  },
  findUser(id: string) {
    return db.users.find((u) => u.id === id);
  },
  findUserByIban(iban: string) {
    const norm = iban.replace(/\s/g, "").toUpperCase();
    return db.users.find((u) => u.iban.replace(/\s/g, "").toUpperCase() === norm);
  },
  findQuote(id: string) {
    return db.quotes.find((q) => q.id === id);
  },
  findTransfer(id: string) {
    return db.transfers.find((t) => t.id === id);
  },

  get cryptoDeposits() {
    return db.cryptoDeposits;
  },
  /** An ERC-20 transfer is identified by its tx and position in it. */
  findCryptoDeposit(txHash: string, logIndex: number) {
    return db.cryptoDeposits.find(
      (d) => d.txHash.toLowerCase() === txHash.toLowerCase() && d.logIndex === logIndex,
    );
  },
  addCryptoDeposit(d: CryptoDeposit) {
    db.cryptoDeposits.push(d);
    persist();
    return d;
  },
  updateCryptoDeposit(id: string, patch: Partial<CryptoDeposit>) {
    const d = db.cryptoDeposits.find((x) => x.id === id);
    if (!d) throw new Error(`unknown crypto deposit ${id}`);
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    persist();
    return d;
  },
  cryptoDepositCursor(chainId: number): bigint | undefined {
    const v = db.cryptoDepositCursor[String(chainId)];
    return v === undefined ? undefined : BigInt(v);
  },
  setCryptoDepositCursor(chainId: number, block: bigint) {
    db.cryptoDepositCursor[String(chainId)] = block.toString();
    persist();
  },
};
