import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { logDecisionAudit } from "@/utils/sender-decision/audit";
import { canonicalizeSender, upsertDecision } from "@/utils/sender-decision";

const ACTIONS = [
  "auto_trash",
  "auto_archive",
  "always_keep",
  "review",
] as const;

const bulkSchema = z.object({
  senderEmails: z.array(z.string().min(1)).min(1).max(500),
  action: z.enum(ACTIONS),
  note: z.string().nullable().optional(),
});

export const POST = withEmailAccount(
  "sender-decisions/bulk",
  async (request) => {
    const emailAccountId = request.auth.emailAccountId;
    const body = await request.json().catch(() => null);
    const parsed = bulkSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { senderEmails, action, note } = parsed.data;

    let updated = 0;
    let skipped = 0;

    for (const raw of senderEmails) {
      const canonical = canonicalizeSender(raw);
      if (!canonical) {
        skipped++;
        continue;
      }

      const before = await prisma.senderDecision.findUnique({
        where: {
          emailAccountId_senderEmail: {
            emailAccountId,
            senderEmail: canonical,
          },
        },
      });

      const after = await upsertDecision({
        emailAccountId,
        senderEmail: canonical,
        action,
        source: "user",
        note: note ?? before?.note ?? null,
        protectUserDecisions: false,
      });

      await logDecisionAudit({
        emailAccountId,
        senderEmail: canonical,
        before,
        after,
        actor: "user",
        action: "bulk",
      });
      updated++;
    }

    return NextResponse.json({ updated, skipped });
  },
);
