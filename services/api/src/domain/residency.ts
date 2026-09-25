/**
 * Residency and citizenship configuration. Country codes live only here.
 *
 * Components, screens and routes ask this module or the segment resolver
 * instead of carrying codes. These lists change for legal reasons on someone
 * else's timetable, and a code hardcoded in a screen gets missed.
 *
 * Three independent questions:
 *
 *   1. Is this person a US person?        -> a legal exclusion we apply ourselves
 *   2. Are they under sanctions?          -> an explicit, short, auditable list
 *   3. Will a partner serve this country? -> Monerium's own residency policy
 *
 * Merging any two gives wrong answers. A Nigerian resident is not sanctioned;
 * Monerium just will not serve them. So question 3 has its own outcome and
 * reason code.
 *
 * Monerium is the reference for question 3: they are the issuer and decide
 * which countries they serve. `country-policy.ts` holds their tier table; this
 * module calls it and does not copy it.
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
 * Sanctions deny list. Residence or citizenship in any of these blocks.
 *
 * Kept short and explicit: it is a legal assertion about specific
 * jurisdictions, checked against citizenship as well as residence (stricter
 * than many firms, and what was asked for). Don't add "a partner declined"
 * countries here; that is question 3 above.
 *
 * Country-level only. Screening individuals against consolidated lists (OFAC
 * SDN, EU, UN, HMT) is the KYC provider's job.
 */
export const SANCTIONED: readonly string[] = ["IR", "KP", "SY", "CU", "RU", "BY"];

/**
 * Regions where Gnosis Pay will not issue a card, but an account is fine.
 *
 * Separate from the sanctions list: Monerium would still serve these people,
 * so this list downgrades the segment (EU_FULL -> ONCHAIN_NO_CARD) and does
 * not block.
 *
 * Empty until read off Gnosis Pay's own terms; a guessed list would remove
 * cards from people entitled to one.
 * TODO(gnosis-pay): populate from Gnosis Pay's published prohibited regions.
 */
export const GNOSIS_PAY_PROHIBITED: readonly string[] = [];

/**
 * ISO codes that count as the United States here.
 *
 * Monerium's tier table rates several US territories as servable (Guam and
 * the US Virgin Islands `medium`, the Northern Mariana Islands `low`), so a
 * territory resident would pass a tier check alone. A US person is a US person
 * wherever they live.
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
