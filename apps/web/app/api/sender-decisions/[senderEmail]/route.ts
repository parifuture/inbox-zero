import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { canonicalizeSender } from "@/utils/sender-decision";
import {
  changeSenderDecision,
  deleteSenderDecision,
} from "@/utils/sender-decision/change";

const ACTIONS = [
  "auto_trash",
  "auto_archive",
  "always_keep",
  "review",
] as const;

const patchSchema = z.object({
  action: z.enum(ACTIONS).optional(),
  note: z.string().nullable().optional(),
  keepLabelId: z.string().nullable().optional(),
  keepLabelName: z.string().nullable().optional(),
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

    const keepLabelIdProvided = Object.hasOwn(parsed.data, "keepLabelId");
    const keepLabelNameProvided = Object.hasOwn(parsed.data, "keepLabelName");

    const after = await changeSenderDecision({
      emailAccountId,
      senderEmail: canonical,
      action: parsed.data.action ?? before.action,
      decisionSource: "user",
      note: parsed.data.note ?? before.note,
      keepLabelId: keepLabelIdProvided
        ? (parsed.data.keepLabelId ?? null)
        : before.keepLabelId,
      keepLabelName: keepLabelNameProvided
        ? (parsed.data.keepLabelName ?? null)
        : before.keepLabelName,
      auditSource: "ui:decisions",
      reason: parsed.data.action
        ? `action=${parsed.data.action}`
        : keepLabelIdProvided || keepLabelNameProvided
          ? "keepLabel updated"
          : null,
      allowOverwriteUser: true,
      actor: "user",
    });

    return NextResponse.json({ item: after.after });
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
    const result = await deleteSenderDecision({
      emailAccountId,
      senderEmail: canonical,
      decisionSource: "user",
      note: null,
      auditSource: "ui:decisions",
      reason: "explicit reset to review",
      actor: "user",
    });

    return NextResponse.json({ item: result.after });
  },
);
