/**
 * The address book. A contact is a payee, not an address: it holds wallets AND
 * bank accounts, and the payout form reads from it.
 *
 * The validator refuses rather than guesses. Which fields a bank account needs
 * depends on the destination country, and a payout built from a plausible-but-
 * wrong identifier does not bounce — it pays a stranger.
 */

import { CURRENCY_REGISTRY, isCurrencyCode } from "./accounts.js";
import type { ContactBankAccount, ContactWallet, CurrencyCode } from "./types.js";

export class ContactError extends Error {}

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const BIC_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** ISO 7064 mod-97-10. A checksum is cheap and catches the transposed digit
 *  that is the common way an IBAN is wrong. */
export function ibanChecksumValid(iban: string): boolean {
  const s = iban.toUpperCase().replace(/\s+/g, "");
  if (!IBAN_RE.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const expanded = rearranged.replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55),
  );
  // Chunked mod to stay inside Number's safe range.
  let remainder = 0;
  for (const ch of expanded) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1;
}

export function normaliseIban(iban: string): string {
  return iban.toUpperCase().replace(/\s+/g, "");
}

/**
 * Which identifier fields a payout to this currency needs. Sourced from the
 * currency registry so a new rail declares its own requirements once.
 */
export function requiredBankFields(currency: CurrencyCode): string[] {
  return CURRENCY_REGISTRY[currency].identifierFields.filter(
    (f) => f !== "bic", // optional everywhere SEPA reaches
  ) as string[];
}

export function validateBankAccount(
  input: Partial<ContactBankAccount>,
): Omit<ContactBankAccount, "id"> {
  const currency = input.currency;
  if (!isCurrencyCode(currency)) {
    throw new ContactError(
      `Unsupported currency ${String(input.currency)}. Supported: ${Object.keys(
        CURRENCY_REGISTRY,
      ).join(", ")}.`,
    );
  }
  const holderName = (input.holderName ?? "").trim();
  if (holderName.length < 2) {
    throw new ContactError(
      "The account holder's name is required — on the bank rails the name is part of the payout identity, not a label.",
    );
  }
  const country = (input.country ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new ContactError("Country must be an ISO 3166-1 alpha-2 code, e.g. DE.");
  }

  const out: Omit<ContactBankAccount, "id"> = {
    currency,
    country,
    holderName,
    label: input.label?.trim() || undefined,
  };

  for (const field of requiredBankFields(currency)) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new ContactError(
        `${CURRENCY_REGISTRY[currency].name} payouts go over ${CURRENCY_REGISTRY[currency].railName} and need ${requiredBankFields(
          currency,
        ).join(" and ")}. Missing: ${field}.`,
      );
    }
  }

  if (currency === "EUR") {
    const iban = normaliseIban(String(input.iban));
    if (!ibanChecksumValid(iban)) {
      throw new ContactError(
        `${iban} is not a valid IBAN — the checksum does not match, which usually means a digit is wrong or transposed.`,
      );
    }
    out.iban = iban;
    if (input.bic) {
      const bic = String(input.bic).toUpperCase().replace(/\s+/g, "");
      if (!BIC_RE.test(bic)) throw new ContactError(`${bic} is not a valid BIC.`);
      out.bic = bic;
    }
  }
  if (currency === "GBP") {
    const sortCode = String(input.sortCode).replace(/[\s-]/g, "");
    if (!/^\d{6}$/.test(sortCode)) {
      throw new ContactError("A UK sort code is six digits.");
    }
    const accountNumber = String(input.accountNumber).replace(/\s+/g, "");
    if (!/^\d{8}$/.test(accountNumber)) {
      throw new ContactError("A UK account number is eight digits.");
    }
    out.sortCode = sortCode;
    out.accountNumber = accountNumber;
  }
  if (currency === "USD") {
    const routingNumber = String(input.routingNumber).replace(/\s+/g, "");
    if (!/^\d{9}$/.test(routingNumber)) {
      throw new ContactError("An ACH routing number is nine digits.");
    }
    out.routingNumber = routingNumber;
    out.accountNumber = String(input.accountNumber).replace(/\s+/g, "");
  }
  if (currency === "KES") {
    const mobile = String(input.mobile).replace(/[\s-]/g, "");
    if (!/^\+?\d{9,15}$/.test(mobile)) {
      throw new ContactError(
        "An M-Pesa number is 9 to 15 digits, optionally with a leading +.",
      );
    }
    out.mobile = mobile;
  }
  if (currency === "INR") {
    const vpa = String(input.vpa).trim();
    if (!/^[\w.\-]{2,64}@[A-Za-z]{2,32}$/.test(vpa)) {
      throw new ContactError("A UPI id looks like name@bank.");
    }
    out.vpa = vpa;
  }

  return out;
}

export function validateWallet(
  input: Partial<ContactWallet>,
): Omit<ContactWallet, "id"> {
  const address = String(input.address ?? "").trim();
  if (!ADDRESS_RE.test(address)) {
    throw new ContactError(`${address || "(empty)"} is not an EVM address.`);
  }
  const chainId = Number(input.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new ContactError("A wallet needs the chain id it lives on.");
  }
  return {
    chainId,
    address: address.toLowerCase() as `0x${string}`,
    label: input.label?.trim() || undefined,
  };
}

/**
 * A stable fingerprint of a destination, used to detect that a saved contact
 * moved under a draft. Compared, never displayed.
 */
export function destinationFingerprint(
  d:
    | { kind: "wallet"; chainId?: number; address?: string; displayName: string }
    | { kind: "bank"; bankAccountId?: string; displayName: string },
  resolve?: (bankAccountId: string) => ContactBankAccount | undefined,
): string {
  if (d.kind === "wallet") {
    return `wallet:${d.chainId}:${(d.address ?? "").toLowerCase()}:${d.displayName}`;
  }
  const bank = d.bankAccountId ? resolve?.(d.bankAccountId) : undefined;
  if (!bank) return `bank:${d.bankAccountId ?? "missing"}:${d.displayName}`;
  const id =
    bank.iban ??
    bank.accountNumber ??
    bank.mobile ??
    bank.vpa ??
    "";
  return `bank:${bank.currency}:${bank.country}:${id}:${bank.holderName}`;
}
