/**
 * EL-375 — SenderDecision CSV import.
 *
 * POST /api/sender-decisions/import
 *   multipart/form-data:
 *     - file: CSV file (UTF-8)
 *     - mode: "dry-run" | "merge"
 *
 * Behaviour:
 *   - Parses the CSV using the shared helpers in `utils/sender-decision/csv.ts`.
 *   - Computes a diff against the current DB state (scoped to the
 *     authenticated email account).
 *   - `mode=dry-run` (default): returns the diff without writing anything.
 *   - `mode=merge`: applies creates + updates via the existing EL-355
 *     `upsertDecision` path (`source="user"`, `protectUserDecisions=false`),
 *     and writes a `SenderDecisionAudit` row for each create/update. Never
 *     deletes — the acceptance rules explicitly forbid silent deletion.
 *
 * Safety:
 *   - Auth: `withEmailAccount` (same gate as other sender-decisions routes).
 *   - No Gmail actions triggered. Import only touches `SenderDecision` +
 *     `SenderDecisionAudit`.
 *   - Malformed emails and unknown actions produce row-level errors that
 *     flow back into the response; they do not abort the transaction.
 *   - Size cap: 5 MB and 50k rows (plenty of headroom for the low-five-digit
 *     volume EL-375 targets).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import {
  type CsvRowError,
  type ImportDiff,
  computeImportDiff,
  parseSenderDecisionCsv,
} from "@/utils/sender-decision/csv";
import { upsertDecision } from "@/utils/sender-decision";
import { logDecisionAudit } from "@/utils/sender-decision/audit";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("sender-decisions/import");

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ROWS = 50_000;

const modeSchema = z.enum(["dry-run", "merge"]).default("dry-run");

export type PostSenderDecisionsImportResponse = {
  mode: "dry-run" | "merge";
  applied: boolean;
  diff: {
    creates: ImportDiff["creates"];
    updates: ImportDiff["updates"];
    skipped: ImportDiff["skipped"];
  };
  errors: CsvRowError[];
  summary: {
    creates: number;
    updates: number;
    skipped: number;
    errors: number;
  };
};

export const POST = withEmailAccount(
  "sender-decisions/import",
  async (request) => {
    const emailAccountId = request.auth.emailAccountId;

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "Expected multipart/form-data" },
        { status: 400 },
      );
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (e) {
      return NextResponse.json(
        {
          error: "Failed to parse form data",
          details: e instanceof Error ? e.message : String(e),
        },
        { status: 400 },
      );
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing 'file' form field" },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        {
          error: `File too large (${file.size} bytes). Max ${MAX_BYTES} bytes.`,
        },
        { status: 413 },
      );
    }

    const parsedMode = modeSchema.safeParse(formData.get("mode") ?? undefined);
    if (!parsedMode.success) {
      return NextResponse.json(
        { error: "Invalid mode. Expected 'dry-run' or 'merge'." },
        { status: 400 },
      );
    }
    const mode = parsedMode.data;

    const text = await file.text();

    const parsed = parseSenderDecisionCsv(text);

    if (parsed.rows.length > MAX_ROWS) {
      return NextResponse.json(
        {
          error: `Too many rows (${parsed.rows.length}). Max ${MAX_ROWS}.`,
        },
        { status: 413 },
      );
    }

    // Pull only the rows we might touch to keep the diff cheap — plus we
    // need all of them so "source=user & no change" rows are correctly
    // classified as skipped.
    const targetEmails = [
      ...new Set(parsed.rows.map((r) => r.senderEmailCanonical)),
    ];
    const existingRows =
      targetEmails.length === 0
        ? []
        : await prisma.senderDecision.findMany({
            where: {
              emailAccountId,
              senderEmail: { in: targetEmails },
            },
            select: {
              senderEmail: true,
              action: true,
              source: true,
              note: true,
            },
          });
    const existingMap = new Map(
      existingRows.map((r) => [r.senderEmail, r] as const),
    );

    const diff = computeImportDiff(parsed, existingMap);

    let applied = false;
    if (mode === "merge" && (diff.creates.length || diff.updates.length)) {
      applied = true;
      for (const c of diff.creates) {
        const after = await upsertDecision({
          emailAccountId,
          senderEmail: c.senderEmail,
          action: c.action,
          source: "user",
          note: c.note,
          protectUserDecisions: false,
        });
        await logDecisionAudit({
          emailAccountId,
          senderEmail: c.senderEmail,
          before: null,
          after,
          actor: "user",
          action: "create",
        });
      }
      for (const u of diff.updates) {
        const before = await prisma.senderDecision.findUnique({
          where: {
            emailAccountId_senderEmail: {
              emailAccountId,
              senderEmail: u.senderEmail,
            },
          },
        });
        const after = await upsertDecision({
          emailAccountId,
          senderEmail: u.senderEmail,
          action: u.after.action,
          source: "user",
          note: u.after.note,
          protectUserDecisions: false,
        });
        await logDecisionAudit({
          emailAccountId,
          senderEmail: u.senderEmail,
          before,
          after,
          actor: "user",
          action: "update",
        });
      }
      logger.info("csv import applied", {
        email_account_id: emailAccountId,
        creates: diff.creates.length,
        updates: diff.updates.length,
        skipped: diff.skipped.length,
        errors: diff.errors.length,
      });
    }

    return NextResponse.json({
      mode,
      applied,
      diff: {
        creates: diff.creates,
        updates: diff.updates,
        skipped: diff.skipped,
      },
      errors: diff.errors,
      summary: {
        creates: diff.creates.length,
        updates: diff.updates.length,
        skipped: diff.skipped.length,
        errors: diff.errors.length,
      },
    } satisfies PostSenderDecisionsImportResponse);
  },
);
