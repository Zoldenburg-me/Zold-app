/**
 * The supplier invoice form's arithmetic, kept to what the server issues
 * (computeTotals in src/domain/invoicing.ts): each line rounded to cents once,
 * after multiplying, then the cents summed. toPrecision(15) drops float noise.
 * An empty field counts as zero while the person is still typing.
 */
export const lineNetCents = (quantity, unitPrice) =>
  Math.round(Number((Number(unitPrice || 0) * Number(quantity || 0) * 100).toPrecision(15)));

export const formTotalCents = (lines) =>
  lines.reduce((s, l) => s + lineNetCents(l.quantity, l.unitPrice), 0);
