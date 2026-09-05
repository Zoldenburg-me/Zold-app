/**
 * Which path an account takes, decided once, on the server.
 *
 * `resolveSegment` is PURE — no store, no network, no clock. Everything it
 * needs arrives in the input. That is what makes it exhaustively testable, and
 * it is the only reason a rule this consequential can be trusted: a resolver
 * that reads a database is a resolver nobody can enumerate.
 *
 * PRECEDENCE IS THE DESIGN. The order below is not stylistic; each rule
 * overrides everything under it, and reordering them changes who gets an
 * account:
 *
 *   1. US person        — a legal exclusion, and it overrides every other fact
 *                         including a servable residence.
 *   2. Sanctions        — residence OR citizenship, short explicit list.
 *   3. Collections-only — India, which OVERRIDES the issuer's own view
 *                         (Monerium rates IN servable; we decline anyway).
 *   4. EU full          — allow list, minus card-prohibited regions.
 *   5. On-chain, no card— whoever Monerium will actually serve.
 *   6. Unsupported      — nobody will serve this residence.
 *
 * WHY (6) EXISTS AND IS NOT "SANCTIONED". Monerium prohibits residences that
 * carry no sanction at all — Nigeria among them. Filing those under
 * BLOCKED_SANCTIONED would be false, and would tell a Nigerian user something
 * about themselves that is not true. It gets its own segment and its own reason
 * code, and the UI copy for it says only what Zold cannot offer.
 *
 * THE REASON CODE IS INTERNAL. It is written to the audit log and never
 * rendered: publishing the rule that fired tells someone which answer to change
 * to get a different outcome.
 */

import {
  cardIsProhibited,
  isCollectionsOnly,
  isEuFullResidence,
  isSanctioned,
  isUsTerritory,
  moneriumWillServe,
} from "./residency.js";
import { normaliseCountryCode } from "../country-policy.js";

export type Segment =
  | "BLOCKED_US"
  | "BLOCKED_SANCTIONED"
  | "BLOCKED_UNSUPPORTED"
  | "EU_FULL"
  | "IN_COLLECTIONS"
  | "ONCHAIN_NO_CARD";

/** Every partner call sits behind one of these. Derived from the segment and
 *  never set directly, so a capability cannot drift from the path. */
export type Capability =
  | "monerium"
  | "gnosis_pay"
  | "safe"
  | "card"
  | "onchain_balance"
  | "xflow_collections";

/**
 * Two wordings are accepted, and the audit log keeps whichever was asked.
 *
 * The COMBINED question — "are you a US citizen, a Green Card holder or a US
 * tax resident?" — is what the app asks today (`usPerson`). The three
 * separate questions are still accepted from older clients and from the
 * harnesses. A caller answers ONE of the two shapes; a combined "no" is not
 * expanded into three separate denials the person never made.
 */
export interface UsPersonAnswers {
  /** Combined: US citizen, Green Card holder or US tax resident. */
  usPerson?: boolean;
  /** a) Are you a US citizen? */
  usCitizen?: boolean;
  /** b) Do you hold a US Green Card? */
  usGreenCard?: boolean;
  /** c) US tax resident / otherwise FATCA reportable? */
  usTaxResident?: boolean;
  /** d) Companies only: incorporated in the US, or any >=25% beneficial owner
   *     answers yes to a-c. Null for individuals — NOT false, because "not
   *     asked" and "asked and denied" are different facts and the audit log
   *     has to be able to tell them apart. */
  companyUsNexus?: boolean | null;
}

export interface SoftSignals {
  usPhoneCode?: boolean;
  usMailingAddress?: boolean;
  usIpAtSignup?: boolean;
}

export interface SegmentInput {
  residence: string;
  /** At least one. A dual national is screened on every citizenship held. */
  citizenships: string[];
  accountType: "individual" | "company";
  usAnswers: UsPersonAnswers;
  /** Companies: where the entity itself is incorporated. */
  companyIncorporationCountry?: string;
  softSignals?: SoftSignals;
}

export interface SegmentDecision {
  segment: Segment;
  /** Internal. Logged, never rendered. */
  reasonCode: string;
  capabilities: Capability[];
  /**
   * Set when the segment is real but cannot be opened in this deployment.
   * IN_COLLECTIONS is gated today: Xflow onboards only platforms incorporated
   * in India, and Zoldenburg UG is not one. Modelled the same way a gated
   * currency is — the request is recognised and recorded, the path is named,
   * and nothing pretends to work.
   */
  gate?: { reason: string; needs: string };
  /**
   * Soft US signals never block — they are weak evidence and blocking on them
   * would refuse real people on a phone number. They raise a flag for review
   * and force the US questions to be answered again.
   */
  review?: { softUsSignals: string[]; requiresUsReconfirmation: true };
}

export class SegmentInputError extends Error {}

const CAPABILITIES: Record<Segment, Capability[]> = {
  EU_FULL: ["monerium", "gnosis_pay", "safe", "card", "onchain_balance"],
  ONCHAIN_NO_CARD: ["monerium", "safe", "onchain_balance"],
  IN_COLLECTIONS: ["xflow_collections"],
  BLOCKED_US: [],
  BLOCKED_SANCTIONED: [],
  BLOCKED_UNSUPPORTED: [],
};

export function capabilitiesFor(segment: Segment): Capability[] {
  return [...CAPABILITIES[segment]];
}

/** The one place a partner call is authorised. Import this, not the segment. */
export function can(segment: Segment, capability: Capability): boolean {
  return CAPABILITIES[segment].includes(capability);
}

const IN_COLLECTIONS_GATE = {
  reason: "Collections for Indian residents are not open yet.",
  needs:
    "an Xflow platform account, which requires a company incorporated in India. Zoldenburg UG is " +
    "German, so no platform account can be opened today. The integration is built and testable " +
    "against Xflow testmode; it cannot be activated until an Indian entity exists.",
} as const;

function assertCountry(value: string, field: string): string {
  const code = normaliseCountryCode(String(value ?? ""));
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new SegmentInputError(`${field} must be an ISO 3166-1 alpha-2 country code.`);
  }
  return code;
}

function collectSoftSignals(s: SoftSignals | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (s.usPhoneCode) out.push("us_phone_code");
  if (s.usMailingAddress) out.push("us_mailing_address");
  if (s.usIpAtSignup) out.push("us_ip_at_signup");
  return out;
}

export function resolveSegment(input: SegmentInput): SegmentDecision {
  const residence = assertCountry(input.residence, "Country of residence");

  if (!Array.isArray(input.citizenships) || input.citizenships.length === 0) {
    throw new SegmentInputError("At least one citizenship is required.");
  }
  const citizenships = input.citizenships.map((c, i) => assertCountry(c, `Citizenship ${i + 1}`));

  const a = input.usAnswers;
  const combined = typeof a?.usPerson === "boolean";
  const separate = a && typeof a.usCitizen === "boolean" && typeof a.usGreenCard === "boolean" &&
    typeof a.usTaxResident === "boolean";
  if (!combined && !separate) {
    throw new SegmentInputError("The US person question must be answered yes or no.");
  }
  // A company that was never asked question (d) has not answered it. Treating
  // undefined as "no" would record a denial nobody made.
  if (input.accountType === "company" && (a.companyUsNexus === undefined || a.companyUsNexus === null)) {
    throw new SegmentInputError("Companies must answer the US ownership and incorporation question.");
  }

  const softUsSignals = collectSoftSignals(input.softSignals);
  const review = softUsSignals.length
    ? { softUsSignals, requiresUsReconfirmation: true as const }
    : undefined;

  const decide = (segment: Segment, reasonCode: string): SegmentDecision => ({
    segment,
    reasonCode,
    capabilities: capabilitiesFor(segment),
    ...(segment === "IN_COLLECTIONS" ? { gate: { ...IN_COLLECTIONS_GATE } } : {}),
    // A blocked account has nothing left to review; the flag is still recorded
    // on the user by the caller, but it cannot change this outcome.
    ...(review && !segment.startsWith("BLOCKED_") ? { review } : {}),
  });

  // 1. US person. Highest precedence: a US citizen resident in Germany is a US
  //    person, and no servable residence changes that.
  if (a.usPerson) return decide("BLOCKED_US", "us_answer_person");
  if (a.usCitizen) return decide("BLOCKED_US", "us_answer_citizen");
  if (a.usGreenCard) return decide("BLOCKED_US", "us_answer_green_card");
  if (a.usTaxResident) return decide("BLOCKED_US", "us_answer_tax_resident");
  if (input.accountType === "company" && a.companyUsNexus === true) {
    return decide("BLOCKED_US", "us_answer_company_nexus");
  }
  if (isUsTerritory(residence)) return decide("BLOCKED_US", "us_residence");
  if (citizenships.some(isUsTerritory)) return decide("BLOCKED_US", "us_citizenship");
  if (input.companyIncorporationCountry &&
      isUsTerritory(assertCountry(input.companyIncorporationCountry, "Country of incorporation"))) {
    return decide("BLOCKED_US", "us_incorporation");
  }

  // 2. Sanctions, on residence OR citizenship.
  if (isSanctioned(residence)) return decide("BLOCKED_SANCTIONED", "sanctioned_residence");
  if (citizenships.some(isSanctioned)) return decide("BLOCKED_SANCTIONED", "sanctioned_citizenship");

  // 3. Collections-only. BEFORE the issuer's own view, which would otherwise
  //    open an account we have decided not to offer.
  if (isCollectionsOnly(residence)) return decide("IN_COLLECTIONS", "collections_only_residence");

  // 4. Full path. A card-prohibited region falls through to (5) rather than
  //    being blocked: the account is fine, only the card is not.
  if (isEuFullResidence(residence) && !cardIsProhibited(residence)) {
    return decide("EU_FULL", "eu_residence");
  }

  // 5. Whoever the issuer will actually serve.
  if (moneriumWillServe(residence)) {
    return decide(
      "ONCHAIN_NO_CARD",
      cardIsProhibited(residence) ? "card_prohibited_region" : "monerium_servable_residence",
    );
  }

  // 6. Nobody will serve this residence. Not a sanction, and never labelled as
  //    one.
  return decide("BLOCKED_UNSUPPORTED", "no_partner_for_residence");
}
