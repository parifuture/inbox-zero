/**
 * EL-375 — SenderDecision CSV export.
 *
 * GET /api/sender-decisions/export
 *
 * Streams a CSV of all `SenderDecision` rows for the authenticated email
 * account. Stable column order (see `utils/sender-decision/csv.ts`):
 *   senderEmail, senderDomain, action, source, note,
 *   messageCount, firstSeenAt, lastSeenAt, updatedAt
 *
 * Safety: read-only. Same auth as the rest of /api/sender-decisions/*.
 */

import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { exportSenderDecisionsToCsv } from "@/utils/sender-decision/csv";

function todayIsoDate(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const GET = withEmailAccount(
  "sender-decisions/export",
  async (request) => {
    const emailAccountId = request.auth.emailAccountId;

    const rows = await prisma.senderDecision.findMany({
      where: { emailAccountId },
      orderBy: [{ senderEmail: "asc" }],
      select: {
        senderEmail: true,
        senderDomain: true,
        action: true,
        source: true,
        note: true,
        messageCount: true,
        firstSeenAt: true,
        lastSeenAt: true,
        updatedAt: true,
      },
    });

    const body = exportSenderDecisionsToCsv(rows);
    const filename = `sender-decisions-${todayIsoDate()}.csv`;

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  },
);
