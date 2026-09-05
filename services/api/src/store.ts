import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IS_PRODUCTION, ROOT } from "./config.js";
import type {
  Account,
  AccountRule,
  ChartAccount,
  Contact,
  DraftPayment,
  ImportedWallet,
  Invoice,
  LedgerEntry,
  Member,
  Organisation,
  WalletGroup,
} from "./domain/types.js";
import { DEFAULT_CHART, DEFAULT_RULES } from "./domain/coa.js";
import { defaultLabel, initialStatusFor } from "./domain/accounts.js";

export type KycStatus = "pending" | "approved" | "rejected" | "manual_review";

export interface User {
  id: string;
  name: string;
  email?: string;
  country: string;
  kycStatus: KycStatus;
  kyc?: {
    provider: "mock" | "manual" | "monerium" | "sumsub";
    onboardingPath?: "existing_monerium" | "new_monerium";
    applicantId?: string;
    checkedAt?: string;
    reason?: string;
    sumsub?: {
      externalUserId: string;
      applicantId?: string;
      reviewStatus?: string;
      reviewAnswer?: string;
      reviewedAt?: string;
      moneriumShare?: {
        profileId: string;
        status: "pending" | "error";
        updatedAt: string;
        error?: string;
      };
    };
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
  /** FP4: the device key allowed to authorize debits from this account. We
   *  store only its address — the private half stays in the user's browser. */
  authorizerAddress?: `0x${string}`;
  wallet?: { type: "candide-safe"; deployed: boolean; deployOpHash?: string };
  /** Testnet faucet grant, recorded so one account is seeded exactly once.
   *  txHash is empty while the transfer is in flight (the synchronous claim
   *  that stops a double completion from paying twice). */
  faucet?: { grantedEur: number; txHash: string; at: string };
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
      allowancePeriodMinutes?: string;
      allowances?: {
        token: `0x${string}`;
        symbol: "EURE" | "USDC";
        amount: string;
      }[];
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
  /**
   * A Gnosis Pay card account the user has CONNECTED — theirs, not ours.
   *
   * Status only. No JWT is ever stored here: it is a bearer credential for a
   * third party's financial account, the browser holds it for the length of a
   * session, and this process keeps nothing that could be replayed. What is
   * here exists so the Card view can say where the user got to without asking
   * them to sign in again just to render a heading.
   *
   * `asOf` is load-bearing rather than decorative: permissionless mode has NO
   * webhooks, so every figure is a snapshot from the last time the user opened
   * the view. Presenting it without a timestamp would imply a liveness the
   * integration cannot provide.
   */
  /**
   * Which path this account takes. Decided once by resolveSegment on the
   * server, at signup.
   *
   * IMMUTABLE FROM THE CLIENT — no route accepts it in a body, and the only
   * writer is the signup path or an explicit admin action, which records itself
   * in the audit log. A segment a client could set is a segment a client could
   * set to EU_FULL.
   */
  segment?: {
    value: import("./domain/segments.js").Segment;
    /** Internal rule that fired. Logged, never rendered — publishing it tells
     *  someone which answer to change. */
    reasonCode: string;
    decidedAt: string;
    decidedBy: "system" | "admin";
    /** Set when the segment exists but cannot be opened in this deployment. */
    gate?: { reason: string; needs: string };
  };
  /**
   * The US-person questionnaire, APPEND-ONLY.
   *
   * A soft US signal forces re-confirmation, and the point of re-confirming is
   * to compare it with what was said the first time — so an answer is added,
   * never overwritten. The version records which wording was agreed to.
   */
  usPersonAnswers?: {
    usCitizen: boolean;
    usGreenCard: boolean;
    usTaxResident: boolean;
    companyUsNexus?: boolean | null;
    answeredAt: string;
    version: string;
  }[];
  /** All citizenships declared at signup. Screened individually. */
  citizenships?: string[];
  accountType?: "individual" | "company";
  companyIncorporationCountry?: string;
  /** Weak US evidence. Flags for review; never blocks on its own. */
  softSignals?: {
    usPhoneCode?: boolean;
    usMailingAddress?: boolean;
    usIpAtSignup?: boolean;
    flaggedAt: string;
    /** Cleared only when the user re-answers the US questions. */
    reconfirmationPending?: boolean;
  };
  /**
   * Consents, append-only, one row per grant. The partner is named because the
   * user consented to a NAMED recipient — a generic "share with partners" is
   * not the consent that was asked for.
   */
  consents?: {
    kind: "zold_terms" | "partner_share";
    partner?: string;
    version: string;
    at: string;
    ip?: string;
  }[];
  gnosisPay?: {
    connectedAddress: `0x${string}`;
    userId?: string;
    safeAddress?: `0x${string}`;
    kycStatus?: string;
    accountStatus?: string;
    cardCount?: number;
    asOf: string;
  };
  paymentPage?: {
    handle: string;
    displayName?: string;
    /** Public receive address shown on /pay/<handle>. In production this is a
     *  Candide Forwarding Address that routes supported deposits into the
     *  merchant's deployed passkey Safe. */
    depositAddress: `0x${string}`;
    /** Destination Safe that should receive forwarded funds. */
    recipientAddress?: `0x${string}`;
    forwarder?: {
      provider: "candide" | "local-safe";
      recipient: `0x${string}`;
      destinationChainId: number;
      sourceChainIds: number[];
      custodialWithdrawer: `0x${string}`;
      salt?: `0x${string}`;
      active: boolean;
      expiresAt?: string;
      activatedAt: string;
    };
    supportedTokens?: {
      chainId: number;
      symbol: "EURE" | "USDC";
      address: `0x${string}`;
      decimals: number;
    }[];
    settlementAsset: "EURE" | "USDC";
    autoConvert: boolean;
    createdAt: string;
    updatedAt: string;
  };
  /** Pre-`paymentPage` fields. Kept only so existing local db.json files can
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
      /** Monerium's permanent "cannot link" verdict on a burned address. */
    addressUnlinkable?: boolean;
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
    /** How the connection authenticates. Absent on rows written before the
     *  API-key connector existed, which were all OAuth. */
    method?: "oauth" | "api_keys";
    profileId?: string;
    accessTokenEnc?: string;
    refreshTokenEnc?: string;
    expiresAt?: string;
    /**
     * The user's OWN Monerium app credentials (client-credentials grant),
     * pasted from their Monerium account's developer section. The secret is
     * AES-256-GCM encrypted at rest and never leaves the server, not even as
     * ciphertext; `baseUrl` records which environment accepted it.
     */
    apiKeys?: {
      clientId: string;
      clientSecretEnc: string;
      baseUrl: string;
      label?: string;
      verifiedAt: string;
      accountEmail?: string;
    };
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

export type PayoutRail = "cash" | "sepa";

export interface Quote {
  id: string;
  userId: string;
  rail: PayoutRail;
  status: "OPEN" | "CONSUMED" | "EXPIRED";
  sendEur: number;
  fixedFeeEur: number;
  fxRate: number; // all-in rate after spread (EUR->KES, 1 for sepa)
  receiveKes: number; // cash rail (0 otherwise)
  receiveEur: number; // sepa rail (0 otherwise)
  /** True market mid from the live feed. A reference we do NOT trade at. */
  midRate: number;
  /** Measured gap between midRate and fxRate. Not a configured constant: an
   *  asserted flat margin over a stale mid says nothing about the real one. */
  marginBps: number;
  /** What the sender really gets per EUR sent, fixed fee included. At small
   *  amounts the flat fee dominates (EUR 2 to cash loses half to it), and an
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
  token: "EURE" | "USDC";
  txHash: string;
  logIndex: number;
  /** Raw token units (EURe is 18dp, USDC is 6dp), as a string — JSON has no bigint. */
  amountUnits: string;
  amountEur?: number;
  amountUsdc?: number;
  /**
   * What this was worth in EUR AT THE MOMENT OF RECEIPT — the acquisition
   * value, and the number the whole tax treatment rests on.
   *
   * A German company has no private sphere (§8 Abs. 2 KStG), so crypto arriving
   * as payment is a Betriebseinnahme at its EUR value on the day, and that
   * value becomes the cost basis. Converting later is a disposal (Tausch)
   * whose gain is measured against exactly this figure. Without it recorded at
   * receipt there is nothing to measure against and nothing to show.
   *
   * THE RATE'S SOURCE IS STORED, NOT JUST THE RATE. The 2025 BMF update on
   * Aufzeichnungspflichten wants a rate from a recognised source applied
   * consistently — "1.1379" alone proves nothing, "1.1379 from <provider> as
   * of <date>" is a record. `ratedAt` is when we read it, `asOf` is when the
   * provider says it was published; they differ and both matter.
   */
  receipt?: {
    amountEur: number;
    /** USD per 1 EUR, the direction midRates() reports. */
    rate: number;
    rateProvider: string;
    rateAsOf: string;
    ratedAt: string;
    /**
     * When the chain says the funds arrived. Detection happens a couple of
     * confirmations later, so this and `ratedAt` are different instants —
     * recorded separately rather than conflated, because which one counts as
     * "receipt" is the Steuerberater's call, not ours.
     */
    blockTimestamp?: string;
  };
  /**
   * Realised on conversion: what was credited minus what it was worth at
   * receipt. Stored as a fact rather than recomputed later from rates nobody
   * kept. Near zero when converted promptly, which is the point.
   */
  realisedGainEur?: number;
  /** The invoice this payment settles, tying Beleg to Zahlung. */
  invoiceId?: string;
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
    cow?: { orderId: string; feeAmount: string; validTo: number; appData: string };
    dex?: { pool: `0x${string}`; fee: number; mid: number; deviationBps: number };
    lifi?: {
      tool: string;
      approvalAddress: `0x${string}`;
      toToken: `0x${string}`;
      tx: { to: `0x${string}`; data: `0x${string}`; value?: string; gasLimit?: string };
      mid: number;
      deviationBps: number;
    };
    executedAt?: string;
    txHash?: string;
  };
  /**
   * Set when this transfer's debit and swap ride in ONE user-signed
   * UserOperation (Change 2, windows 1-3): the batch approves the venue and
   * delivers the output straight to `recipient`, so the orchestrator never
   * holds the input. `recipient` is the orchestrator only in local dry-run
   * (the local demo settles from it); in live mode it is the Bridge deposit
   * address, and once the batch lands the funds are already with the
   * settlement custodian — which is why compensation must not assume it can
   * reverse-swap them.
   */
  /**
   * Did the orchestrator hold this transfer's input funds?
   *
   * Recorded at creation, on EVERY transfer and every rail, because the answer
   * has regulatory weight and must not be derivable only by replaying which
   * venue was configured and whether a venue call happened to succeed. A
   * fallback from the Safe-executed batch to the plain debit changes the
   * answer, so it names itself.
   *
   *  non-custodial — the user's funds never reach an address we hold a key to.
   *                  The cash-rail batch delivering straight to Bridge, and the
   *                  SEPA rail, where Monerium burns the payout from the Safe
   *                  and only the fee moves.
   *  orchestrator   — the input was debited to the orchestrator's own address
   *                  and swapped from there. `reason` says why that path ran.
   *
   * The fee is excluded from this judgement on purpose: it is revenue at the
   * moment it moves, not client funds in transit. `feeToOrchestrator` records
   * it anyway rather than leaving it to be discovered.
   */
  custody?: {
    mode: "non-custodial" | "orchestrator";
    /** Why the custodial path ran. Absent when it did not. */
    reason?: string;
    /** The fee always lands at the orchestrator; stated, not hidden. */
    feeToOrchestrator?: boolean;
  };
  safeSwap?: {
    recipient: `0x${string}`;
    mode: "dry-run" | "live";
    /** Live mode: the amount the Bridge transfer was created with at transfer
     *  creation. Execute re-creates under the same idempotency key, so it must
     *  send exactly this amount — a different body is not an idempotent replay. */
    bridgeAmountUsdc?: number;
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
    /** Bridge.xyz transfer funding this anchor withdrawal. */
    bridgeTransferId?: string;
    bridgeState?: string;
    bridgeDepositAddress?: string;
    bridgeDepositMemo?: string;
    bridgeDestinationTxHash?: string;
  };
  /** SEPA payout leg: a real Monerium redeem order in sandbox, or a mock. */
  sepa?: { mode: "sandbox" | "mock"; orderId?: string; state: string; detail?: string };
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


/**
 * A shareable receipt for one transfer, and the sender's choice of what it
 * exposes.
 *
 * The selections live here rather than on the link because the link is the one
 * thing a stranger holds: anything encoded into it is something they can edit.
 * `GET /api/r/:slug` builds the payload from these fields and never sends a
 * value the sender withheld — the redaction is done before the response, not
 * by the page that renders it.
 *
 * A share is revocable and expires. Both are recorded rather than implied by
 * deleting the row, so a recipient who opens a dead link is told which of the
 * two happened.
 */
export interface ReceiptShare {
  id: string;
  /** Public path segment. Unguessable, because holding it is the whole auth. */
  slug: string;
  transferId: string;
  userId: string;
  fields: ReceiptShareFields;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface ReceiptShareFields {
  sender: "full" | "first" | "last" | "hidden";
  recipient: "full" | "first" | "last" | "hidden";
  /** IBAN on the SEPA rail, mobile number on the cash rail. */
  account: "full" | "short" | "hidden";
  /** Which side's currency the page leads with. */
  fx: "both" | "sender" | "recipient";
  showRate: boolean;
  showRef: boolean;
  /** Whether the settlement route section exists on the page at all. */
  route: boolean;
}

interface Db {
  users: User[];
  quotes: Quote[];
  transfers: Transfer[];
  sessions: Session[];
  /** Public shareable receipts, keyed by an unguessable slug. */
  receiptShares: ReceiptShare[];
  /** Monerium issue-order ids already reflected in local receipt state. */
  processedMoneriumOrders: string[];
  /** Monerium webhook delivery ids already accepted. */
  processedMoneriumWebhooks: string[];
  /** Inbound crypto seen at a user's account, and what became of it. */
  cryptoDeposits: CryptoDeposit[];
  /** Append-only audit trail: segment decisions, consents, partner events. */
  audit: import("./audit.js").AuditEntry[];
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

  // ── The organisation domain (docs/business-accounts.md) ───────────────────
  //
  // A User is only a login identity; the tenant that holds money is an
  // Organisation, and a user reaches one through a Member row. Users that
  // predate organisations are migrated into a personal org of one on first
  // start — see migrateUsersToOrganisations().
  organisations: Organisation[];
  members: Member[];
  accounts: Account[];
  importedWallets: ImportedWallet[];
  walletGroups: WalletGroup[];
  contacts: Contact[];
  drafts: DraftPayment[];
  invoices: Invoice[];
  chartAccounts: ChartAccount[];
  accountRules: AccountRule[];
  ledger: LedgerEntry[];
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
  receiptShares: [],
  processedMoneriumOrders: [],
  processedMoneriumWebhooks: [],
  cryptoDeposits: [],
  audit: [],
  recoveryRequests: [],
  cryptoDepositCursor: {},
  organisations: [],
  members: [],
  accounts: [],
  importedWallets: [],
  walletGroups: [],
  contacts: [],
  drafts: [],
  invoices: [],
  chartAccounts: [],
  accountRules: [],
  ledger: [],
};

export function initStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(DB_PATH)) {
    db = JSON.parse(readFileSync(DB_PATH, "utf8"));
    db.sessions ??= [];
    db.receiptShares ??= [];
    db.processedMoneriumOrders ??= [];
    db.processedMoneriumWebhooks ??= [];
    db.cryptoDeposits ??= [];
    db.audit ??= [];
    db.recoveryRequests ??= [];
    db.cryptoDepositCursor ??= {};
    db.organisations ??= [];
    db.members ??= [];
    db.accounts ??= [];
    db.importedWallets ??= [];
    db.walletGroups ??= [];
    db.contacts ??= [];
    db.drafts ??= [];
    db.invoices ??= [];
    db.chartAccounts ??= [];
    db.accountRules ??= [];
    db.ledger ??= [];
    if (IS_PRODUCTION) {
      const custodial = db.users.filter((u) => (u.paymentPage as any)?.depositPrivateKey);
      if (custodial.length) {
        throw new Error(
          `production store contains ${custodial.length} account(s) with API-held payment-page key material; ` +
            "activate non-custodial payment pages before startup",
        );
      }
    }
    migrateUsersToOrganisations();
    for (const q of db.quotes) q.status ??= "OPEN";
    for (const s of db.sessions) s.expiresAt ??= new Date(Date.parse(s.createdAt) + 24 * 60 * 60 * 1000).toISOString();
    pruneSessions();
    persist();
  } else {
    persist();
  }
}

/**
 * Drop sessions that can no longer authenticate anything. Kept forever, every
 * request would pay for them twice: a linear scan to find the live one, and a
 * full re-serialisation of the file on write.
 */
function pruneSessions(retainMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - retainMs;
  db.sessions = db.sessions.filter((s) => {
    const dead = s.revokedAt ? Date.parse(s.revokedAt) : Date.parse(s.expiresAt);
    return !(Number.isFinite(dead) && dead < cutoff);
  });
}

/**
 * Give every user created before organisations existed a personal
 * organisation of one.
 *
 * Those users have a real IBAN and a real on-chain address — on Base Sepolia
 * some of them hold credited EUR — so the migration must CARRY THEM FORWARD,
 * not re-issue. The org's EUR account
 * therefore takes the user's existing `iban` and `address` verbatim, and its
 * status is derived from the user's funding state rather than assumed active:
 * a user who never finished provisioning must not acquire an account that
 * claims to be open.
 *
 * Idempotent — keyed on a member row existing for the user — so it is safe on
 * every start, and it never touches a user who already has an org.
 */
function migrateUsersToOrganisations() {
  let migrated = 0;
  for (const user of db.users) {
    if (db.members.some((m) => m.userId === user.id)) continue;

    const now = user.createdAt ?? new Date().toISOString();
    const org: Organisation = {
      id: `org_${randomUUID()}`,
      type: "personal",
      name: user.name || "Personal",
      email: user.email,
      address: user.country ? { country: user.country.toUpperCase() } : undefined,
      plan: "starter",
      reporting: {
        currency: "EUR",
        timeZone: "Europe/Berlin",
        costBasisMethod: "FIFO",
      },
      // The user's KYC decision is an account-issuance verification and nothing
      // more. It is deliberately NOT copied onto fiat_payout or cards: those
      // are separate partners' decisions and we were never given them.
      verifications: {
        account_issuance: {
          capability: "account_issuance",
          status:
            user.kycStatus === "approved"
              ? "approved"
              : user.kycStatus === "rejected"
                ? "rejected"
                : user.kycStatus === "manual_review"
                  ? "in_review"
                  : "unverified",
          provider: user.kyc?.provider === "monerium" ? "monerium" : "manual",
          applicantId: user.kyc?.applicantId,
          decidedAt: user.kyc?.checkedAt,
          reason: user.kyc?.reason,
        },
      },
      createdAt: now,
      updatedAt: new Date().toISOString(),
    };
    db.organisations.push(org);

    db.members.push({
      id: `mem_${randomUUID()}`,
      orgId: org.id,
      userId: user.id,
      email: user.email ?? "",
      name: user.name,
      role: "owner",
      status: "active",
      invitedAt: now,
      acceptedAt: now,
    });

    // Carry the existing EUR account across rather than opening a new one.
    const funded = user.funding?.status === "active" && Boolean(user.iban);
    const initial = initialStatusFor("EUR");
    db.accounts.push({
      id: `acc_${randomUUID()}`,
      orgId: org.id,
      currency: "EUR",
      label: defaultLabel("EUR"),
      status: funded ? "active" : initial.status,
      provider: "monerium",
      identifier: user.iban ? { iban: user.iban } : {},
      address: user.address,
      // This account IS that user's Safe, so it is spendable by exactly the
      // person holding its device key — see Account.backingUserId.
      backingUserId: user.id,
      gate: funded ? undefined : initial.gate,
      detail: user.funding?.detail,
      createdAt: now,
      updatedAt: new Date().toISOString(),
    });

    seedChartOfAccounts(org.id, now);
    migrated++;
  }
  if (migrated) {
    console.log(
      `[store] migrated ${migrated} user(s) into personal organisations ` +
        "(existing IBANs and addresses carried forward, not re-issued)",
    );
  }
}

/** The default chart and rules, so smart categorisation works on day one. */
function seedChartOfAccounts(orgId: string, at = new Date().toISOString()) {
  if (db.chartAccounts.some((c) => c.orgId === orgId)) return;
  for (const a of DEFAULT_CHART) {
    db.chartAccounts.push({
      id: `coa_${randomUUID()}`,
      orgId,
      code: a.code,
      name: a.name,
      type: a.type,
      archived: false,
      createdAt: at,
    });
  }
  for (const r of DEFAULT_RULES) {
    db.accountRules.push({
      id: `rule_${randomUUID()}`,
      orgId,
      scope: "default",
      match: { txType: r.txType },
      direction: r.direction,
      accountCode: r.accountCode,
      createdAt: at,
    });
  }
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
  /**
   * Append one audit entry. There is deliberately no update and no delete —
   * a log a process can edit proves nothing.
   */
  audit(entry: import("./audit.js").AuditEntry) {
    db.audit.push(entry);
    persist();
  },
  auditFor(userId?: string, limit = 200) {
    const rows = userId ? db.audit.filter((r) => r.userId === userId) : db.audit;
    return rows.slice(-limit).reverse();
  },
  /**
   * Set the segment. The ONLY writer, and it refuses to be a silent overwrite:
   * a segment already decided can be changed only by an explicit admin action,
   * so a second signup-path call cannot quietly re-segment an existing account.
   */
  setSegment(
    id: string,
    segment: NonNullable<User["segment"]>,
    by: "system" | "admin" = "system",
  ) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    if (u.segment && by !== "admin") {
      throw new Error(
        `user ${id} already has segment ${u.segment.value}; only an admin action may change it`,
      );
    }
    u.segment = { ...segment, decidedBy: by };
    persist();
    return u;
  },
  /** Append-only: consents and US answers are never overwritten. */
  addConsent(id: string, consent: NonNullable<User["consents"]>[number]) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    (u.consents ??= []).push(consent);
    persist();
    return u;
  },
  addUsAnswers(id: string, answers: NonNullable<User["usPersonAnswers"]>[number]) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    (u.usPersonAnswers ??= []).push(answers);
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
  /**
   * One share per transfer, deliberately.
   *
   * Re-sharing a transfer edits the existing record instead of minting a second
   * slug, so tightening a selection actually tightens what is public. Two live
   * links to one transfer would mean the generous first link kept working after
   * the sender thought they had narrowed it.
   */
  findReceiptShareByTransfer(transferId: string) {
    const shares = db.receiptShares.filter((s) => s.transferId === transferId);
    return shares.find((s) => !s.revokedAt) ?? shares.at(-1);
  },
  findReceiptShareBySlug(slug: string) {
    return db.receiptShares.find((s) => s.slug === slug);
  },
  addReceiptShare(s: ReceiptShare) {
    db.receiptShares.push(s);
    persist();
  },
  updateReceiptShare(id: string, patch: Partial<ReceiptShare>) {
    const s = db.receiptShares.find((x) => x.id === id);
    if (!s) throw new Error(`unknown receipt share ${id}`);
    Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    persist();
    return s;
  },
  revokeReceiptShare(id: string) {
    const s = db.receiptShares.find((x) => x.id === id);
    if (!s) throw new Error(`unknown receipt share ${id}`);
    s.revokedAt = new Date().toISOString();
    s.updatedAt = s.revokedAt;
    persist();
    return s;
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
    return db.users.find((u) => u.paymentPage?.handle === h);
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
  cryptoDepositCursor(chainId: number | string): bigint | undefined {
    const v = db.cryptoDepositCursor[String(chainId)];
    return v === undefined ? undefined : BigInt(v);
  },
  setCryptoDepositCursor(chainId: number | string, block: bigint) {
    db.cryptoDepositCursor[String(chainId)] = block.toString();
    persist();
  },

  // ── Organisation domain ───────────────────────────────────────────────────
  //
  // Reads return live rows; every write goes through here so a single atomic
  // persist covers the whole file. Deliberately NO delete for organisations,
  // accounts, invoices or ledger entries: plan downgrades and archival must not
  // be reachable by a code path that removes rows (see plans.ts rule 1).

  get organisations() {
    return db.organisations;
  },
  get members() {
    return db.members;
  },
  get accounts() {
    return db.accounts;
  },
  get contacts() {
    return db.contacts;
  },
  get drafts() {
    return db.drafts;
  },
  get invoices() {
    return db.invoices;
  },
  get importedWallets() {
    return db.importedWallets;
  },
  get walletGroups() {
    return db.walletGroups;
  },
  get chartAccounts() {
    return db.chartAccounts;
  },
  get accountRules() {
    return db.accountRules;
  },
  get ledger() {
    return db.ledger;
  },

  addOrganisation(org: Organisation, seedCoa = true) {
    db.organisations.push(org);
    if (seedCoa) seedChartOfAccounts(org.id, org.createdAt);
    persist();
    return org;
  },
  findOrganisation(id: string) {
    return db.organisations.find((o) => o.id === id);
  },
  updateOrganisation(id: string, patch: Partial<Organisation>) {
    const o = db.organisations.find((x) => x.id === id);
    if (!o) throw new Error(`unknown organisation ${id}`);
    Object.assign(o, patch, { updatedAt: new Date().toISOString() });
    persist();
    return o;
  },
  /** Every org a user can reach, with the membership that grants it. */
  organisationsForUser(userId: string) {
    return db.members
      .filter((m) => m.userId === userId && m.status === "active")
      .map((m) => ({ member: m, org: db.organisations.find((o) => o.id === m.orgId) }))
      .filter((x): x is { member: Member; org: Organisation } => Boolean(x.org));
  },

  addMember(m: Member) {
    db.members.push(m);
    persist();
    return m;
  },
  findMember(id: string) {
    return db.members.find((m) => m.id === id);
  },
  /** The membership joining this user to this org, active or not. */
  memberFor(orgId: string, userId: string) {
    return db.members.find((m) => m.orgId === orgId && m.userId === userId);
  },
  findMemberByInviteHash(tokenHash: string) {
    return db.members.find((m) => m.invite?.tokenHash === tokenHash);
  },
  membersOf(orgId: string) {
    return db.members.filter((m) => m.orgId === orgId);
  },
  updateMember(id: string, patch: Partial<Member>) {
    const m = db.members.find((x) => x.id === id);
    if (!m) throw new Error(`unknown member ${id}`);
    Object.assign(m, patch);
    persist();
    return m;
  },

  addAccount(a: Account) {
    db.accounts.push(a);
    persist();
    return a;
  },
  findAccount(id: string) {
    return db.accounts.find((a) => a.id === id);
  },
  accountsOf(orgId: string) {
    return db.accounts.filter((a) => a.orgId === orgId);
  },
  updateAccount(id: string, patch: Partial<Account>) {
    const a = db.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`unknown account ${id}`);
    Object.assign(a, patch, { updatedAt: new Date().toISOString() });
    persist();
    return a;
  },

  addContact(c: Contact) {
    db.contacts.push(c);
    persist();
    return c;
  },
  findContact(id: string) {
    return db.contacts.find((c) => c.id === id);
  },
  contactsOf(orgId: string) {
    return db.contacts.filter((c) => c.orgId === orgId);
  },
  updateContact(id: string, patch: Partial<Contact>) {
    const c = db.contacts.find((x) => x.id === id);
    if (!c) throw new Error(`unknown contact ${id}`);
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    persist();
    return c;
  },
  removeContact(id: string) {
    const before = db.contacts.length;
    db.contacts = db.contacts.filter((c) => c.id !== id);
    persist();
    return db.contacts.length < before;
  },

  addDraft(d: DraftPayment) {
    db.drafts.push(d);
    persist();
    return d;
  },
  findDraft(id: string) {
    return db.drafts.find((d) => d.id === id);
  },
  draftsOf(orgId: string) {
    return db.drafts.filter((d) => d.orgId === orgId);
  },
  updateDraft(id: string, patch: Partial<DraftPayment>) {
    const d = db.drafts.find((x) => x.id === id);
    if (!d) throw new Error(`unknown draft ${id}`);
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    persist();
    return d;
  },
  /**
   * Claim a draft for execution, synchronously.
   *
   * Same shape as claimAuthorization above and for the same reason: everything
   * from the state check to the write happens with no await between, so two
   * parallel submissions of one draft cannot both pass. Returns null when
   * somebody else already claimed it.
   *
   * `from` is the set of states this caller may claim out of: ["REVIEWED"] for
   * an org with approvals, ["DRAFT"] for one without. Passed in rather than
   * hardcoded so the plan decides, but still checked here — inside the same
   * synchronous window as the write.
   */
  claimDraftExecution(id: string, from: DraftPayment["state"][] = ["REVIEWED"]): DraftPayment | null {
    const d = db.drafts.find((x) => x.id === id);
    if (!d || !from.includes(d.state)) return null;
    d.state = "EXECUTING";
    d.updatedAt = new Date().toISOString();
    persist();
    return d;
  },

  addInvoice(i: Invoice) {
    db.invoices.push(i);
    persist();
    return i;
  },
  findInvoice(id: string) {
    return db.invoices.find((i) => i.id === id);
  },
  findInvoiceByLinkHash(hash: string) {
    return db.invoices.find((i) => i.linkTokenHash === hash);
  },
  invoicesOf(orgId: string) {
    return db.invoices.filter((i) => i.orgId === orgId);
  },
  updateInvoice(id: string, patch: Partial<Invoice>) {
    const i = db.invoices.find((x) => x.id === id);
    if (!i) throw new Error(`unknown invoice ${id}`);
    Object.assign(i, patch, { updatedAt: new Date().toISOString() });
    persist();
    return i;
  },

  addImportedWallet(w: ImportedWallet) {
    db.importedWallets.push(w);
    persist();
    return w;
  },
  findImportedWallet(id: string) {
    return db.importedWallets.find((w) => w.id === id);
  },
  importedWalletsOf(orgId: string) {
    return db.importedWallets.filter((w) => w.orgId === orgId);
  },
  updateImportedWallet(id: string, patch: Partial<ImportedWallet>) {
    const w = db.importedWallets.find((x) => x.id === id);
    if (!w) throw new Error(`unknown imported wallet ${id}`);
    Object.assign(w, patch);
    persist();
    return w;
  },
  removeImportedWallet(id: string) {
    const before = db.importedWallets.length;
    db.importedWallets = db.importedWallets.filter((w) => w.id !== id);
    persist();
    return db.importedWallets.length < before;
  },

  addWalletGroup(g: WalletGroup) {
    db.walletGroups.push(g);
    persist();
    return g;
  },
  walletGroupsOf(orgId: string) {
    return db.walletGroups.filter((g) => g.orgId === orgId);
  },

  chartOf(orgId: string) {
    return db.chartAccounts.filter((c) => c.orgId === orgId);
  },
  addChartAccount(c: ChartAccount) {
    db.chartAccounts.push(c);
    persist();
    return c;
  },
  updateChartAccount(id: string, patch: Partial<ChartAccount>) {
    const c = db.chartAccounts.find((x) => x.id === id);
    if (!c) throw new Error(`unknown chart account ${id}`);
    Object.assign(c, patch);
    persist();
    return c;
  },
  rulesOf(orgId: string) {
    return db.accountRules.filter((r) => r.orgId === orgId);
  },
  addAccountRule(r: AccountRule) {
    db.accountRules.push(r);
    persist();
    return r;
  },
  removeAccountRule(id: string) {
    const before = db.accountRules.length;
    db.accountRules = db.accountRules.filter((r) => r.id !== id);
    persist();
    return db.accountRules.length < before;
  },
  seedChartOfAccounts(orgId: string) {
    seedChartOfAccounts(orgId);
    persist();
  },

  ledgerOf(orgId: string) {
    return db.ledger.filter((e) => e.orgId === orgId);
  },
  addLedgerEntries(entries: LedgerEntry[]) {
    db.ledger.push(...entries);
    persist();
    return entries;
  },
  updateLedgerEntry(id: string, patch: Partial<LedgerEntry>) {
    const e = db.ledger.find((x) => x.id === id);
    if (!e) throw new Error(`unknown ledger entry ${id}`);
    Object.assign(e, patch);
    persist();
    return e;
  },
  /** Bulk replace after a rule run. Takes whole rows so one persist covers it. */
  replaceLedgerEntries(entries: LedgerEntry[]) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    db.ledger = db.ledger.map((e) => byId.get(e.id) ?? e);
    persist();
  },
};
