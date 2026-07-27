import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

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
  /** Candide Safe smart-account address — the user's identity everywhere:
   *  the RemitVault ledger and the address Monerium attaches the IBAN to. */
  address: `0x${string}`;
  ownerAddress?: `0x${string}`; // EOA owner (signer) of the Safe
  /** Owner key of the Safe. MVP-grade custody: needed to sign Monerium's
   *  ownership declaration and UserOperations. Production: KMS/passkeys. */
  privateKey?: `0x${string}`;
  /** FP4: the device key allowed to authorize debits from this account. We
   *  store only its address — the private half stays in the user's browser.
   *  Registered once against RemitVault.authorizerOf; after that only the
   *  device itself can rotate it. */
  authorizerAddress?: `0x${string}`;
  wallet?: { type: "candide-safe"; deployed: boolean; deployOpHash?: string };
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

export interface Transfer {
  id: string;
  userId: string;
  quoteId: string;
  rail: PayoutRail;
  recipientName: string;
  recipientPhone?: string; // cash rail
  recipientIban?: string; // sepa rail
  recipientVpa?: string; // upi rail (merchant/recipient UPI ID)
  state: TransferState;
  sendEur: number;
  receiveKes: number; // cash rail
  receiveEur?: number; // sepa rail
  receiveInr?: number; // upi rail
  usdcOut?: number;
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
  txs: { step: string; hash: string }[];
  /** Internal JIT liquidity execution details. This records how value moved
   *  into the settlement asset for the payout rail; it is not a swap product. */
  liquidity?: {
    provider: "fx-swapper" | "rfq";
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
    rfq?: { quoteId: string; tx: { to?: string; data?: string; value?: string } | null };
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
  /** Monerium issue-order ids already mirrored into the vault. */
  processedMoneriumOrders: string[];
  /** Monerium webhook delivery ids already accepted. */
  processedMoneriumWebhooks: string[];
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
};

export function initStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(DB_PATH)) {
    db = JSON.parse(readFileSync(DB_PATH, "utf8"));
    db.sessions ??= [];
    db.processedMoneriumOrders ??= [];
    db.processedMoneriumWebhooks ??= [];
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
  findUserByAddress(address: string) {
    return db.users.find((u) => u.address.toLowerCase() === address.toLowerCase());
  },
  findUserByCredential(credentialId: string) {
    return db.users.find((u) => u.passkey?.credentialId === credentialId);
  },
  /** Every Monerium order id we have mirrored into the vault. */
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
   * both passed the `state === "CREATED"` check, both submitted `debit`, and the
   * loser's "duplicate transfer" revert drove the compensation path: the vault
   * re-credited the sender while the winner was still completing the payout.
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
};
