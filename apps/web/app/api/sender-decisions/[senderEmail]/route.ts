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

const patchSchema = z.object({
  action: z.enum(ACTIONS).optional(),
  note: z.string().nullable().optional(),
});

function decodeSenderParam(raw: string): string {
  return canonicalizeSender(decodeURIComponent(raw));
}

export const PATCH = withEmailAccount(
  "sender-decisions/patch",
  async (request, { params }) => {
    const emailAccountId = request.auth.emailAccountId;
    const { senderEmail: rawSender } = await params;
    const canonical = decodeSenderParam(rawSender);
    if (!canonical) {
      return NextResponse.json(
        { error: "Invalid sender email" },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const before = await prisma.senderDecision.findUnique({
      where: {
        emailAccountId_senderEmail: { emailAccountId, senderEmail: canonical },
      },
    });

    if (!before) {
      return NextResponse.json(
        { error: "Decision not found" },
        { status: 404 },
      );
    }

    const after = await upsertDecision({
      emailAccountId,
      senderEmail: canonical,
      action: parsed.data.action ?? before.action,
      source: "user",
      note: parsed.data.note ?? before.note,
      protectUserDecisions: false,
    });

    await logDecisionAudit({
      emailAccountId,
      senderEmail: canonical,
      before,
      after,
      actor: "user",
      action: "update",
    });

    return NextResponse.json({ item: after });
  },
);

export const DELETE = withEmailAccount(
  "sender-decisions/delete",
  async (request, { params }) => {
    const emailAccountId = request.auth.emailAccountId;
    const { senderEmail: rawSender } = await params;
    const canonical = decodeSenderParam(rawSender);
    if (!canonical) {
      return NextResponse.json(
        { error: "Invalid sender email" },
        { status: 400 },
      );
    }

    const before = await prisma.senderDecision.findUnique({
      where: {
        emailAccountId_senderEmail: { emailAccountId, senderEmail: canonical },
      },
    });

    if (!before) {
      return NextResponse.json(
        { error: "Decision not found" },
        { status: 404 },
      );
    }

    // Reset to `review` + source=user (explicit "undo") rather than hard-delete
    // so we preserve volume telemetry + audit trail.
    const after = await upsertDecision({
      emailAccountId,
      senderEmail: canonical,
      action: "review",
      source: "user",
      note: null,
      protectUserDecisions: false,
    });

    await logDecisionAudit({
      emailAccountId,
      senderEmail: canonical,
      before,
      after,
      actor: "user",
      action: "delete",
    });

    return NextResponse.json({ item: after });
  },
);
