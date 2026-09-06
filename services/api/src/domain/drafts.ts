/**
 * Draft payments: create → submit for review → reviewed → execute.
 *
 * The workflow exists because a business payment has more than one person in
 * it. Two rules carry the weight:
 *
 *  - FOUR EYES. The reviewer may not be the drafter (roles.ts enforces it).
 *    Without that, review is a button the same person presses twice.
 *  - INVALID_DATA. If the contact behind a line moved after the draft was
 *    saved, the draft STOPS instead of retargeting. A payment that silently
 *    follows an edited address book is how money reaches the wrong account
 *    with a complete and innocent-looking audit trail.
 */

import { destinationFingerprint } from "./contacts.js";
import type {
  Contact,
  DraftLine,
  DraftPayment,
  DraftState,
} from "./types.js";

export class DraftError extends Error {}

/** Legal moves. Anything not listed is refused by name, not by falling through. */
const TRANSITIONS: Record<DraftState, DraftState[]> = {
  // DRAFT -> EXECUTING is legal only for an org WITHOUT the approvals
  // capability: on Starter there is no review step, so requiring REVIEWED
  // would make every draft unsendable. The route enforces which of the two
  // applies; the state machine allows both shapes.
  DRAFT: ["PENDING_REVIEW", "INVALID_DATA", "EXECUTING"],
  PENDING_REVIEW: ["REVIEWED", "REJECTED", "DRAFT", "INVALID_DATA"],
  REVIEWED: ["EXECUTING", "DRAFT", "INVALID_DATA"],
  REJECTED: ["DRAFT"],
  INVALID_DATA: ["DRAFT"],
  EXECUTING: ["EXECUTED", "FAILED"],
  EXECUTED: [],
  FAILED: ["DRAFT"],
};

export function assertTransition(from: DraftState, to: DraftState) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new DraftError(
      `A draft cannot go from ${from} to ${to}. Allowed from ${from}: ${
        TRANSITIONS[from]?.join(", ") || "nothing — this is a final state"
      }.`,
    );
  }
}

/** States in which the draft's lines may still be edited. */
export function isEditable(state: DraftState): boolean {
  return state === "DRAFT" || state === "INVALID_DATA" || state === "REJECTED";
}

const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

/**
 * Validate one line, stamping the destination fingerprint when the contact it
 * came from is supplied. Pass the contact whenever there is one — a line saved
 * without a fingerprint can never be found to have drifted.
 */
export function validateLine(
  input: Partial<DraftLine>,
  contact?: Contact,
): Omit<DraftLine, "id"> {
  const amount = String(input.amount ?? "").trim();
  if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) {
    throw new DraftError(
      `"${amount}" is not a payable amount. Use a positive decimal string, e.g. "125.00".`,
    );
  }
  const asset = String(input.asset ?? "").trim();
  if (!asset) throw new DraftError("Each line needs an asset or currency.");

  const d = input.destination;
  if (!d || (d.kind !== "wallet" && d.kind !== "bank")) {
    throw new DraftError("Each line needs a destination of kind wallet or bank.");
  }
  const displayName = String(d.displayName ?? "").trim();
  if (!displayName) {
    throw new DraftError(
      "Each line needs the payee's name — on the bank rails it is part of the payout identity.",
    );
  }
  if (d.kind === "wallet") {
    // Shape-checked here, not only at the address book: a bulk CSV builds
    // destinations directly, so without this a malformed address becomes a
    // payable line and is only caught by the chain, if at all.
    if (!d.address) throw new DraftError("A wallet destination needs an address.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(d.address))) {
      throw new DraftError(`"${d.address}" is not an EVM address.`);
    }
  }
  if (d.kind === "bank" && !d.bankAccountId) {
    throw new DraftError("A bank destination needs a saved bank account.");
  }

  const destination = { ...d, displayName };
  if (contact) {
    destination.fingerprint = currentFingerprint({ destination }, contact);
  }

  return {
    contactId: input.contactId,
    ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
    destination,
    asset,
    amount,
    accountCode: input.accountCode,
    note: input.note?.trim() || undefined,
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
  };
}

/**
 * Re-check every line against the address book as it stands now.
 *
 * Returns the ids of lines whose saved contact no longer matches what was
 * approved. Called before review and again immediately before execution —
 * the second check is the one that matters, because the gap between approval
 * and execution is exactly where an address book edit lands.
 */
export function findDriftedLines(
  draft: DraftPayment,
  contactsById: Map<string, Contact>,
): string[] {
  const drifted: string[] = [];
  for (const line of draft.lines) {
    if (!line.contactId) continue; // ad-hoc destination; nothing to drift from

    const contact = contactsById.get(line.contactId);
    if (!contact) {
      drifted.push(line.id); // contact deleted out from under the draft
      continue;
    }

    // Is the destination still one this contact actually holds?
    const stillListed =
      line.destination.kind === "wallet"
        ? contact.wallets.some(
            (w) =>
              w.address.toLowerCase() ===
                (line.destination.address ?? "").toLowerCase() &&
              w.chainId === line.destination.chainId,
          )
        : contact.bankAccounts.some(
            (b) => b.id === line.destination.bankAccountId,
          );
    if (!stillListed) {
      drifted.push(line.id);
      continue;
    }

    // And do its details still match what was approved? A bank account keeps
    // its id when its IBAN is edited, so only the fingerprint catches this.
    const current = currentFingerprint(line, contact);
    if (line.destination.fingerprint && line.destination.fingerprint !== current) {
      drifted.push(line.id);
    }
  }
  return drifted;
}

/**
 * Fingerprint of a line's destination as the contact stands NOW. Save-time
 * fingerprints come from the same function, so the two are comparable.
 */
export function currentFingerprint(
  line: Pick<DraftLine, "destination">,
  contact: Contact,
): string {
  return destinationFingerprint(line.destination as never, (id) =>
    contact.bankAccounts.find((b) => b.id === id),
  );
}

/** Sum per asset, for the review screen. Strings in, strings out. */
export function totalsByAsset(draft: DraftPayment): Record<string, string> {
  const totals: Record<string, number> = {};
  for (const line of draft.lines) {
    totals[line.asset] = (totals[line.asset] ?? 0) + Number(line.amount);
  }
  return Object.fromEntries(
    Object.entries(totals).map(([asset, n]) => [asset, n.toFixed(2)]),
  );
}

export function activity(
  actorMemberId: string,
  action: string,
  detail?: string,
): DraftPayment["activity"][number] {
  return { at: new Date().toISOString(), actorMemberId, action, detail };
}

// ── Bulk CSV import ─────────────────────────────────────────────────────────

export const CSV_MAX_ROWS = 500;
export const CSV_MAX_BYTES = 2 * 1024 * 1024;

export interface CsvMapping {
  recipientAddress: string;
  token: string;
  amount: string;
  recipientName?: string;
  account?: string;
  notes?: string;
  tags?: string;
}

/**
 * Minimal RFC 4180 reader — quoted fields, doubled quotes, embedded newlines.
 * Written out rather than pulled in because a payment file is the wrong place
 * to be surprised by a dependency's quirks.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export interface CsvImportResult {
  lines: Omit<DraftLine, "id">[];
  /** Rows we could not use, by 1-based row number, with the reason. Reported
   *  rather than dropped: a bulk file that silently loses rows pays fewer
   *  people than the operator believes it does. */
  rejected: { row: number; reason: string }[];
  /** Tags in the file that the org does not have yet. Gnosis created these
   *  automatically; we surface them so the caller decides. */
  newTags: string[];
}

export function importCsv(
  text: string,
  mapping: CsvMapping,
  opts: { maxRows?: number; knownTags?: Set<string> } = {},
): CsvImportResult {
  const maxRows = opts.maxRows ?? CSV_MAX_ROWS;
  const rows = parseCsv(text);
  if (!rows.length) throw new DraftError("That file has no rows.");

  const header = rows[0].map((h) => h.trim());
  const body = rows.slice(1);
  if (body.length > maxRows) {
    throw new DraftError(
      `That file has ${body.length} rows; the limit on this plan is ${maxRows}.`,
    );
  }

  const col = (name?: string) => (name ? header.indexOf(name) : -1);
  const idx = {
    address: col(mapping.recipientAddress),
    token: col(mapping.token),
    amount: col(mapping.amount),
    name: col(mapping.recipientName),
    account: col(mapping.account),
    notes: col(mapping.notes),
    tags: col(mapping.tags),
  };
  for (const [k, v] of Object.entries({
    "Recipient Address": idx.address,
    Token: idx.token,
    Amount: idx.amount,
  })) {
    if (v < 0) {
      throw new DraftError(
        `The file has no column mapped to ${k}. Columns found: ${header.join(", ")}.`,
      );
    }
  }

  const lines: Omit<DraftLine, "id">[] = [];
  const rejected: { row: number; reason: string }[] = [];
  const newTags = new Set<string>();

  body.forEach((cells, i) => {
    const rowNo = i + 2; // 1-based, past the header
    try {
      const tags =
        idx.tags >= 0
          ? (cells[idx.tags] ?? "")
              .split(";")
              .map((t) => t.trim())
              .filter(Boolean)
          : [];
      for (const t of tags) if (!opts.knownTags?.has(t)) newTags.add(t);

      lines.push(
        validateLine({
          destination: {
            kind: "wallet",
            address: (cells[idx.address] ?? "").trim() as `0x${string}`,
            chainId: 0, // filled by the caller from the funding source
            displayName:
              idx.name >= 0 && cells[idx.name]?.trim()
                ? cells[idx.name].trim()
                : (cells[idx.address] ?? "").trim(),
          },
          asset: (cells[idx.token] ?? "").trim(),
          amount: (cells[idx.amount] ?? "").trim(),
          accountCode: idx.account >= 0 ? cells[idx.account]?.trim() : undefined,
          note: idx.notes >= 0 ? cells[idx.notes]?.trim() : undefined,
          tags,
        }),
      );
    } catch (err) {
      rejected.push({ row: rowNo, reason: (err as Error).message });
    }
  });

  return { lines, rejected, newTags: [...newTags] };
}
