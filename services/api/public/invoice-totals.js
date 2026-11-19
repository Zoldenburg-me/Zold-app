/**
 * The supplier invoice form's arithmetic, kept to what the server stores on
 * submit (validateLines in src/domain/invoices.ts, POST
 * /api/invoice-links/:token/submit): each line rounded to cents once, after
 * multiplying, then the cents summed. The rounding is lineNetCents in
 * src/domain/invoicing.ts; toPrecision(15) drops float noise.
 *
 * A value the server refuses (AMOUNT_RE: digits, at most 8 decimals, no sign
 * or exponent; a quantity above zero; an empty field) gives null, and the
 * form shows no number for it. AMOUNT_RE is the server's own pattern
 * (invoices.ts); invoice-form-test checks the two are equal.
 */
export const AMOUNT_RE = /^\d+(\.\d{1,8})?$/;

const amount = (raw) => {
  const s = String(raw ?? "").trim();
  return AMOUNT_RE.test(s) ? Number(s) : null;
};

export const lineNetCents = (quantity, unitPrice) => {
  const q = amount(quantity);
  const p = amount(unitPrice);
  if (q === null || p === null || q <= 0) return null;
  return Math.round(Number((p * q * 100).toPrecision(15)));
};

export const formTotalCents = (lines) => {
  let total = 0;
  for (const l of lines) {
    const cents = lineNetCents(l.quantity, l.unitPrice);
    if (cents === null) return null;
    total += cents;
  }
  return total;
};

/** Cents as the form prints them, or a dash for a line the server would refuse. */
export const formatCents = (cents) => (cents === null ? "—" : (cents / 100).toFixed(2));
