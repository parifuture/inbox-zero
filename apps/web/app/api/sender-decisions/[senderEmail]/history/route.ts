import { NextResponse } from "next/server";
import { z } from "zod";
import type { SenderDecisionAudit } from "@/generated/prisma/client";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { canonicalizeSender } from "@/utils/sender-decision";

export type SenderDecisionHistoryItem = {
  id: string;
  senderEmail: string;
  before: SenderDecisionAudit["before"];
  after: SenderDecisionAudit["after"];
  actor: string;
  action: string;
  source: string | null;
  reason: string | null;
  createdAt: string;
};

export type SenderDecisionHistoryResponse = {
  items: SenderDecisionHistoryItem[];
  senderEmail: string;
};

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = withEmailAccount(
  "sender-decisions/history",
  async (request, { params }) => {
    const emailAccountId = request.auth.emailAccountId;
    const { senderEmail: rawSender } = await params;
    const canonical = canonicalizeSender(decodeURIComponent(rawSender));
    if (!canonical) {
      return NextResponse.json(
        { error: "Invalid sender email" },
        { status: 400 },
      );
    }

    const url = new URL(request.url);
    const parsed = querySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const rows = await prisma.senderDecisionAudit.findMany({
      where: { emailAccountId, senderEmail: canonical },
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
    });

    const items: SenderDecisionHistoryItem[] = rows.map((r) => ({
      id: r.id,
      senderEmail: r.senderEmail,
      before: r.before,
      after: r.after,
      actor: r.actor,
      action: r.action,
      source: r.source,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    }));

    return NextResponse.json({
      items,
      senderEmail: canonical,
    } satisfies SenderDecisionHistoryResponse);
  },
);
