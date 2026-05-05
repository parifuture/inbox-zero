import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { canonicalizeSender } from "@/utils/sender-decision";
import { changeSenderDecision } from "@/utils/sender-decision/change";

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

      const existing = await prisma.senderDecision.findUnique({
        where: {
          emailAccountId_senderEmail: {
            emailAccountId,
            senderEmail: canonical,
          },
        },
        select: { note: true },
      });

      await changeSenderDecision({
        emailAccountId,
        senderEmail: canonical,
        action,
        decisionSource: "user",
        note: note ?? existing?.note ?? null,
        auditSource: "ui:decisions",
        reason: `bulk:${senderEmails.length} senders`,
        kind: "bulk",
        allowOverwriteUser: true,
        actor: "user",
      });
      updated++;
    }

    return NextResponse.json({ updated, skipped });
  },
);
