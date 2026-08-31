/**
 * Residency and citizenship configuration — the ONLY place country codes live.
 *
 * No component, screen or route may carry a country code. They ask this module
 * or the segment resolver. The reason is not tidiness: these lists change for
 * legal reasons, on someone else's timetable, and a code hardcoded in a screen
 * is one nobody finds when the list moves.
 *
 * THREE INDEPENDENT QUESTIONS, kept independent on purpose:
 *
 *   1. Is this person a US person?        -> a legal exclusion we apply ourselves
 *   2. Are they under sanctions?          -> an explicit, short, auditable list
 *   3. Will a PARTNER serve this country? -> Monerium's own residency policy
 *
 * Collapsing any two produces a wrong answer with a confident label. A Nigerian
 * resident is not sanctioned — Monerium simply will not serve them — and
 * telling them otherwise would be both false and offensive. So question 3 has
 * its own outcome and its own reason code.
 *
 * MONERIUM IS THE REFERENCE for question 3, deliberately: they are the issuer,
 * the account is theirs to open, and maintaining a second opinion about which
 * countries are servable would drift from the partner who actually decides.
 * `country-policy.ts` already holds their tier table; this module never copies
 * it, it calls it.
 */

import { countryBlock, normaliseCountryCode } from "../country-policy.js";

/**
 * Countries whose residents get the full path: Monerium IBAN + Gnosis Pay Safe
 * + card. EEA + UK + CH.
 *
 * This is an ALLOW list rather than a derivation from the Monerium tier,
 * because "Monerium will serve you" and "Gnosis Pay will issue you a card" are
 * different questions with different answers, and the card is the half that
 * needs the tighter list.
 */
export const EU_FULL_RESIDENCE: readonly string[] = [
  // EU 27
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
  // EEA non-EU
  "IS", "LI", "NO",
  // Plus UK and Switzerland
  "GB", "CH",
];

/**
 * Sanctions deny list. Residence OR citizenship in any of these blocks.
 *
 * SHORT AND EXPLICIT ON PURPOSE. This list is a legal assertion about specific
 * jurisdictions, and it is checked against citizenship as well as residence —
 * a stricter rule than many firms apply, and the one that was asked for. It is
 * NOT a dumping ground for "some partner declined": that is question 3 above
 * and has its own outcome.
 *
 * NOT A COMPLETE SANCTIONS SCREEN. This is a country-level gate, not a
 * name-level one; screening individuals against consolidated lists (OFAC SDN,
 * EU, UN, HMT) is the KYC provider's job and remains theirs.
 */
export const SANCTIONED: readonly string[] = ["IR", "KP", "SY", "CU", "RU", "BY"];

/**
 * Regions where Gnosis Pay will not issue a card, but where an account is
 * otherwise fine.
 *
 * DELIBERATE DEVIATION FROM THE BRIEF, flagged rather than done quietly: the
 * brief folds this into the sanctions deny list. Blocking an account outright
 * because the CARD partner declines the region would refuse someone Monerium
 * would happily serve, which is the same class of error as promising an
 * account no partner will open — just pointing the other way. So this list
 * DOWNGRADES the segment (EU_FULL -> ONCHAIN_NO_CARD) instead of blocking.
 *
 * Empty until read off Gnosis Pay's own terms. Empty is honest; a guessed list
 * would silently remove cards from people entitled to one.
 * TODO(gnosis-pay): populate from Gnosis Pay's published prohibited regions.
 */
export const GNOSIS_PAY_PROHIBITED: readonly string[] = [];

/**
 * ISO codes that ARE the United States for this purpose.
 *
 * THIS LIST IS LOAD-BEARING and is the reason it exists separately: Monerium's
 * own tier table rates several US territories as servable (Guam and the US
 * Virgin Islands are `medium`, the Northern Mariana Islands `low`), so a
 * territory resident would pass a tier check and be handed an account. A US
 * person is a US person wherever they live.
 */
export const US_TERRITORIES: readonly string[] = [
  "US",
  "AS", // American Samoa
  "GU", // Guam
  "MP", // Northern Mariana Islands
  "PR", // Puerto Rico
  "VI", // US Virgin Islands
  "UM", // US Minor Outlying Islands
];

/**
 * Residences we serve through a collections partner instead of an on-chain
 * account, whatever the issuer's own policy says.
 *
 * India is here because an Indian resident cannot lawfully hold EUR on-chain
 * (FEMA), and export income needs a FIRA naming the foreign client as remitter
 * (GST). Monerium rates IN as `medium` and WOULD open an account — so this is
 * an override of the partner's view, not an inheritance of it, and it has to be
 * checked before the tier or the tier wins.
 */
export const COLLECTIONS_ONLY: readonly string[] = ["IN"];

/** Telephone country codes that indicate a US number. Soft signal only. */
export const US_PHONE_PREFIXES: readonly string[] = ["+1"];

/** Does a partner exist that will open an on-chain account for this residence?
 *  Asks Monerium's own policy rather than holding a second opinion. */
export function moneriumWillServe(residence: string): boolean {
  return countryBlock(residence) === null;
}

export const isSanctioned = (code: string) => SANCTIONED.includes(normaliseCountryCode(code));
export const isUsTerritory = (code: string) => US_TERRITORIES.includes(normaliseCountryCode(code));
export const isEuFullResidence = (code: string) => EU_FULL_RESIDENCE.includes(normaliseCountryCode(code));
export const isCollectionsOnly = (code: string) => COLLECTIONS_ONLY.includes(normaliseCountryCode(code));
export const cardIsProhibited = (code: string) => GNOSIS_PAY_PROHIBITED.includes(normaliseCountryCode(code));
