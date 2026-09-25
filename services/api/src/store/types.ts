export type KycStatus = "pending" | "approved" | "rejected" | "manual_review";

export interface User {
  id: string;
  name: string;
  email?: string;
  country: string;
  kycStatus: KycStatus;
  kyc?: {
    /** Identity is Monerium's. The other literals only describe rows written
     *  before the in-house, mock and Sumsub paths were removed. */
    provider: "monerium" | "manual" | "mock" | "sumsub";
    onboardingPath?: "existing_monerium";
    applicantId?: string;
    checkedAt?: string;
    reason?: string;
  };
  iban: string; // funding IBAN — mock-issued, or real from Monerium sandbox
  /** Candide Safe smart-account address — the user's identity and balance
   *  account, and the address Monerium attaches the IBAN to. */
  address: `0x${string}`;
  /** The device key allowed to authorize debits from this account. We
   *  store only its address — the private half stays in the user's browser. */
  authorizerAddress?: `0x${string}`;
  wallet?: { type: "candide-safe"; deployed: boolean; deployOpHash?: string };
    /**
   * Passkey Safe state. The passkey is the only owner (threshold 1).
   */
  passkeySafe?: {
    address: `0x${string}`;
    status: "planned" | "active";
    threshold: 1;
    passkeyPublicKey: { x: string; y: string };
    recovery?: {
      moduleAddress: `0x${string}`;
      guardianAddress: `0x${string}`;
      threshold: 1;
      status: "planned" | "active";
      enabledAt?: string;
    };
    /**
     * Candide's email/SMS guardian on this Safe.
     *
     * `channels` are the OTP channels registered with Candide's recovery
     * service; `guardianAddress` is the key Candide signs recoveries with and
     * is only worth anything once it is IN THE MODULE's guardian set, which
     * `guardianStatus` tracks — "pending_setup" means the service knows the
     * user but the Safe does not yet know the guardian, and no recovery can
     * run. Targets are stored as given (a phone number, an email) and masked
     * on every public read.
     */
    candideRecovery?: {
      moduleAddress: `0x${string}`;
      guardianAddress: `0x${string}`;
      channels: { registrationId: string; channel: "email" | "sms"; target: string; verifiedAt: string }[];
      guardianStatus: "pending_setup" | "active";
      guardianOpHash?: string;
      activatedAt?: string;
    };
    createdAt: string;
    previousAddress?: `0x${string}`;
    /** Set once a recovery replaced the owner: the Safe keeps its address but
     *  that address is no longer the counterfactual one of its current owner,
     *  so the account must be built from the address, never re-derived. */
    recoveredAt?: string;
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
   * Which path this account takes, decided once by resolveSegment at signup.
   *
   * No route accepts it in a body: a client that could set it could set
   * EU_FULL. The only writers are the signup path and an admin action, which
   * records itself in the audit log.
   */
  segment?: {
    value: import("../domain/segments.js").Segment;
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
    /** Combined wording (current app): citizen, Green Card or tax resident. */
    usPerson?: boolean;
    usCitizen?: boolean;
    usGreenCard?: boolean;
    usTaxResident?: boolean;
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
    /** Legacy: written before Sep 2026, never written now, never sent. */
    ip?: string;
  }[];
  /**
   * A Gnosis Pay card account the user connected (theirs, not ours). Status
   * only. The JWT is a bearer credential for a third party's account and stays
   * in the browser. Permissionless mode has no webhooks, so every figure is a
   * snapshot as of `asOf`, the last time the user opened the view.
   */
  gnosisPay?: {
    connectedAddress: `0x${string}`;
    userId?: string;
    safeAddress?: `0x${string}`;
    kycStatus?: string;
    accountStatus?: string;
    cardCount?: number;
    asOf: string;
  };
  /**
   * Public payment page, e.g. `alice` serving /pay/alice. It has its own
   * deposit address: the settlement rule belongs to the page, and transfers
   * into the user's main wallet must not be swept just because a public
   * payment link exists.
   */
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
  /** `sandbox` states track Monerium provisioning. `mock` survives only on rows
   *  written before locally issued IBANs were removed. */
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
    /** sha256 of the nonce cookie set at connect/start; the callback must
     *  arrive from the same browser. */
    nonceHash?: string;
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
  /** Quote binding: the liquidity venue's rate (tokenOut units per 1e18 tokenIn) this
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
 * Recorded before anything is moved or credited, so a crash between detection
 * and conversion leaves a record to resume from. `txHash` + `logIndex`
 * identifies an ERC-20 transfer and makes reprocessing a no-op.
 *
 * REFUSED is a resting state, not something to retry: nothing was credited and
 * the tokens are still the user's, where they landed.
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
   * EUR value at the moment of receipt: the acquisition value the tax
   * treatment rests on.
   *
   * A German company has no private sphere (§8 Abs. 2 KStG), so crypto taken
   * as payment is a Betriebseinnahme at its EUR value on the day, and that
   * value is the cost basis. A later conversion is a disposal (Tausch) whose
   * gain is measured against this figure, so it must be recorded at receipt.
   *
   * The rate's source is stored with the rate: the 2025 BMF update on
   * Aufzeichnungspflichten wants a rate from a recognised source applied
   * consistently. `ratedAt` is when we read it, `asOf` is when the provider
   * says it was published; the two differ.
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
  /** The payment request (pay link) this deposit was matched to by amount.
   *  Set by payment-requests.ts; absent for money nobody asked for. */
  paymentRequestId?: string;
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
  /**
   * The independent mid the venue's rate was checked against at the time of
   * the swap. Stored so the reported spread can be checked.
   */
  midRate?: number;
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
  /** The terms the device is asked to authorize. Fixed when the transfer
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
   * Once the Safe is passkey owned, the browser must sign this while
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
   * Did the orchestrator hold this transfer's input funds?
   *
   * Recorded at creation on every transfer and rail. The answer has regulatory
   * weight, so it must not depend on replaying which venue was configured and
   * whether a venue call succeeded. A fallback from the Safe-executed batch to
   * the plain debit changes the answer, so it records itself.
   *
   *  non-custodial — the user's funds never reach an address we hold a key to.
   *                  The cash-rail batch delivering straight to Bridge, and the
   *                  SEPA rail, where Monerium burns the payout from the Safe
   *                  and only the fee moves.
   *  orchestrator   — the input was debited to the orchestrator's own address
   *                  and swapped from there. `reason` says why that path ran.
   *
   * The fee is excluded: it is revenue when it moves, not client funds in
   * transit. `feeToOrchestrator` records it anyway.
   */
  custody?: {
    mode: "non-custodial" | "orchestrator";
    /** Why the custodial path ran. Absent when it did not. */
    reason?: string;
    /** The fee always lands at the orchestrator; stated, not hidden. */
    feeToOrchestrator?: boolean;
  };
  /**
   * Set when this transfer's debit and swap ride in ONE user-signed
   * UserOperation (Change 2, windows 1-3): the batch approves the venue and
   * delivers the output straight to `recipient`, so the orchestrator never
   * holds the input. `recipient` is the Bridge deposit address ("dry-run" survives only on
   * rows written before the rail was closed without BRIDGE_LIVE), and once the batch lands the funds are already with the
   * settlement custodian — which is why compensation must not assume it can
   * reverse-swap them.
   */
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
  /** SEPA payout leg: a Monerium redeem order (`sandbox` is the historical
   *  literal for it). `mock` survives only on rows from the removed mock path. */
  sepa?: { mode: "sandbox" | "mock"; orderId?: string; state: string; detail?: string };
  error?: string;
  /** Automated compensation after failure. Refund amount depends on
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
  /** Candide guardian: the recovering browser has not registered its new passkey yet. */
  | "PASSKEY_PENDING"
  /** Candide guardian: OTPs outstanding on one or more registered channels. */
  | "OTP_PENDING"
  /** Candide guardian: executed on chain; the owner may still cancel until `finalizeAfter`. */
  | "GRACE_PERIOD"
  | "FINALIZED"
  | "CANCELED"
  | "EXPIRED";

export interface RecoveryRequest {
  id: string;
  userId: string;
  safeAddress: `0x${string}`;
  /** `managed` (operator-approved, external signer) unless set. */
  mode?: "managed" | "candide";
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
  /**
   * Candide email/SMS recovery, driven by the person who lost their device.
   *
   * `newPasskey` is the credential the recovering browser registered. It is
   * held HERE, not on the user, until the chain confirms the new owner: a
   * credential that could sign in before the grace period ended would let
   * whoever holds the OTP channels read the account while the real owner
   * still has the right to cancel.
   */
  candide?: {
    /** sha256 (hex) of the per-request secret given once to the browser that
     *  started the recovery. Every by-id route requires the secret; neither the
     *  id nor the account's email is enough. Not on the public projection. */
    accessHash?: string;
    /** sha256 (hex) of the single-use ticket handed to the browser that
     *  registered `newPasskey`. Every OTP submission requires it, so channel
     *  codes can only confirm a credential that browser created. Cleared once
     *  every code is accepted. Never on the public projection. */
    otpTicketHash?: string;
    newPasskey?: {
      credentialId: string;
      publicKey: { jwk: JsonWebKey; alg: "ES256" | "RS256" };
      signCount: number;
      rpId: string;
      attestation?: string;
      createdAt: string;
    };
    /** The owner set the recovery installs: the new passkey's signer only. */
    newOwners?: `0x${string}`[];
    newThreshold?: number;
    /** Candide's signature-request id and the OTP challenges it issued. */
    serviceRequestId?: string;
    requiredVerifications?: number;
    auths?: { challengeId: string; channel: string; target: string; verified: boolean }[];
    guardianAddress?: string;
    /** Candide's recovery request id once created and executed on chain. */
    recoveryRequestId?: string;
    executedAt?: string;
    gracePeriodSeconds?: number;
    /** Wrong codes so far on the no-session OTP route. */
    otpAttempts?: number;
    finalizeAfter?: string;
    verifierDeployTxHash?: string;
    finalizeAttempts?: number;
    finalizeError?: string;
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
/** Owned by their own modules; re-exported so `store` names one shape. */
export type { StoredDocument } from "../documents.js";
export type { PaymentRequest } from "../payment-requests.js";
export type { ShopifyConnection } from "../shopify/types.js";

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
