/**
 * EL-375 — SenderDecision ↔ CSV translation + dry-run diff computation.
 *
 * CSV shape (stable — scripts and spreadsheets depend on this order):
 *   senderEmail, senderDomain, action, source, note,
 *   messageCount, firstSeenAt, lastSeenAt, updatedAt
 *
 * Only `senderEmail` and `action` are required on import. Everything else is
 * ignored on import (canonicalized/recomputed server-side) except `note`,
 * which is carried through. On export all columns are emitted.
 *
 * Safety posture (see EL-375 acceptance):
 *   - Import never silently deletes rows. It only adds or updates.
 *   - Malformed email or unknown action produces a row-level error; the
 *     whole import still produces a diff (errors don't abort the preview).
 *   - In `merge` mode, imported rows become `source="user"`. A row that was
 *     previously `source="seed"` therefore transitions to `source="user"`
 *     on change — the audit log captures the transition.
 */

import type { SenderDecision } from "@/generated/prisma/client";
import type { SenderAction } from "@/generated/prisma/enums";
import { canonicalizeSender } from "@/utils/sender-decision";
import { parseCsv, stringifyCsv } from "@/utils/csv";

export const CSV_HEADER = [
  "senderEmail",
  "senderDomain",
  "action",
  "source",
  "note",
  "messageCount",
  "firstSeenAt",
  "lastSeenAt",
  "updatedAt",
] as const;

export const ACTIONS = [
  "auto_trash",
  "auto_archive",
  "always_keep",
  "review",
] as const satisfies readonly SenderAction[];

export function isValidAction(raw: string): raw is SenderAction {
  return (ACTIONS as readonly string[]).includes(raw);
}

export function exportSenderDecisionsToCsv(
  rows: readonly Pick<
    SenderDecision,
    | "senderEmail"
    | "senderDomain"
    | "action"
    | "source"
    | "note"
    | "messageCount"
    | "firstSeenAt"
    | "lastSeenAt"
    | "updatedAt"
  >[],
): string {
  const body = rows.map((r) => [
    r.senderEmail,
    r.senderDomain,
    r.action,
    r.source,
    r.note ?? "",
    String(r.messageCount ?? 0),
    r.firstSeenAt ? r.firstSeenAt.toISOString() : "",
    r.lastSeenAt ? r.lastSeenAt.toISOString() : "",
    r.updatedAt ? r.updatedAt.toISOString() : "",
  ]);
  return stringifyCsv(CSV_HEADER, body);
}

export interface ParsedCsvRow {
  action: SenderAction | null;
  actionRaw: string;
  note: string | null;
  rowIndex: number; // 1-based, excluding header
  senderEmailCanonical: string;
  senderEmailRaw: string;
}

export interface CsvParseResult {
  errors: CsvRowError[];
  rows: ParsedCsvRow[];
}

export interface CsvRowError {
  field?: string;
  message: string;
  raw?: string;
  row: number; // 1-based, excluding header
}

/**
 * Parse a CSV buffer into validated rows. Validation is row-level: each row
 * is independent, and errors are collected rather than thrown.
 */
export function parseSenderDecisionCsv(text: string): CsvParseResult {
  const matrix = parseCsv(text);
  if (matrix.length === 0) {
    return { rows: [], errors: [{ row: 0, message: "Empty CSV" }] };
  }
  const header = matrix[0].map((h) => h.trim());
  const emailIdx = header.indexOf("senderEmail");
  const actionIdx = header.indexOf("action");
  const noteIdx = header.indexOf("note");

  if (emailIdx === -1 || actionIdx === -1) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: `Missing required header column(s). Required: senderEmail, action. Got: ${header.join(", ")}`,
        },
      ],
    };
  }

  const rows: ParsedCsvRow[] = [];
  const errors: CsvRowError[] = [];

  for (let i = 1; i < matrix.length; i++) {
    const raw = matrix[i];
    const rowIndex = i;

    // Skip fully empty rows (defensive — parseCsv already strips pure \n tails).
    if (raw.every((c) => c === "")) continue;

    const senderEmailRaw = (raw[emailIdx] ?? "").trim();
    const actionRaw = (raw[actionIdx] ?? "").trim();
    const note = noteIdx !== -1 ? (raw[noteIdx] ?? "").trim() || null : null;

    const canonical = canonicalizeSender(senderEmailRaw);
    if (!canonical) {
      errors.push({
        row: rowIndex,
        field: "senderEmail",
        message: "Invalid or missing email address",
        raw: senderEmailRaw,
      });
      continue;
    }

    if (!isValidAction(actionRaw)) {
      errors.push({
        row: rowIndex,
        field: "action",
        message: `Invalid action "${actionRaw}". Expected one of: ${ACTIONS.join(", ")}`,
        raw: actionRaw,
      });
      continue;
    }

    rows.push({
      senderEmailRaw,
      senderEmailCanonical: canonical,
      action: actionRaw,
      actionRaw,
      note,
      rowIndex,
    });
  }

  return { rows, errors };
}

export interface DiffCreate {
  action: SenderAction;
  kind: "create";
  note: string | null;
  rowIndex: number;
  senderEmail: string;
}

export interface DiffUpdate {
  after: {
    action: SenderAction;
    source: string;
    note: string | null;
  };
  before: {
    action: SenderAction;
    source: string;
    note: string | null;
  };
  kind: "update";
  rowIndex: number;
  senderEmail: string;
}

export interface DiffSkip {
  kind: "skip";
  reason: string;
  rowIndex: number;
  senderEmail: string;
}

export type DiffEntry = DiffCreate | DiffUpdate | DiffSkip;

export interface ImportDiff {
  creates: DiffCreate[];
  errors: CsvRowError[];
  skipped: DiffSkip[];
  updates: DiffUpdate[];
}

/**
 * Compute the diff for a parsed CSV against the set of rows currently in the
 * database (provided by the caller to keep this pure and testable).
 * `source` is always "user" on import — see EL-375 acceptance.
 */
export function computeImportDiff(
  parsed: CsvParseResult,
  existing: ReadonlyMap<
    string,
    Pick<SenderDecision, "action" | "source" | "note">
  >,
): ImportDiff {
  const creates: DiffCreate[] = [];
  const updates: DiffUpdate[] = [];
  const skipped: DiffSkip[] = [];

  // De-duplicate rows in the CSV itself (last one wins, but we flag dupes).
  const seen = new Map<string, ParsedCsvRow>();
  for (const row of parsed.rows) {
    const prev = seen.get(row.senderEmailCanonical);
    if (prev) {
      skipped.push({
        kind: "skip",
        senderEmail: prev.senderEmailCanonical,
        reason: `Duplicate in CSV (keeping row ${row.rowIndex}, skipping row ${prev.rowIndex})`,
        rowIndex: prev.rowIndex,
      });
    }
    seen.set(row.senderEmailCanonical, row);
  }

  for (const row of seen.values()) {
    const before = existing.get(row.senderEmailCanonical);
    const afterAction = row.action as SenderAction;
    if (!before) {
      creates.push({
        kind: "create",
        senderEmail: row.senderEmailCanonical,
        action: afterAction,
        note: row.note,
        rowIndex: row.rowIndex,
      });
      continue;
    }
    const noteUnchanged = (before.note ?? null) === (row.note ?? null);
    const sourceUnchanged = before.source === "user";
    const actionUnchanged = before.action === afterAction;
    if (actionUnchanged && noteUnchanged && sourceUnchanged) {
      skipped.push({
        kind: "skip",
        senderEmail: row.senderEmailCanonical,
        reason: "No change",
        rowIndex: row.rowIndex,
      });
      continue;
    }
    updates.push({
      kind: "update",
      senderEmail: row.senderEmailCanonical,
      before: {
        action: before.action,
        source: before.source,
        note: before.note ?? null,
      },
      after: {
        action: afterAction,
        source: "user",
        note: row.note,
      },
      rowIndex: row.rowIndex,
    });
  }

  return { creates, updates, skipped, errors: parsed.errors };
}
