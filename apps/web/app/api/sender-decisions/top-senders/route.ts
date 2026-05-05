/**
 * EL-374 — "top senders" recommendation endpoint for the first-time
 * Decisions onboarding flow.
 *
 * GET /api/sender-decisions/top-senders?limit=20&excludeExisting=true
 *
 * Returns the N senders with the highest inbound message count that do
 * NOT already have a SenderDecision row (pass `excludeExisting=false` to
 * include them). Sent / draft messages are excluded from the count.
 *
 * The onboarding wizard (empty-state Decisions page) consumes this to
 * pre-populate the review list. No writes.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { canonicalizeSender } from "@/utils/sender-decision";

export type TopSender = {
  senderEmail: string;
  senderDomain: string;
  messageCount: number;
  lastSeenAt: string | null;
};

export type GetTopSendersResponse = {
  senders: TopSender[];
};

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  excludeExisting: z
    .union([z.literal("true"), z.literal("false")])
    .default("true")
    .transform((v) => v === "true"),
});

export const GET = withEmailAccount(
  "sender-decisions/top-senders",
  async (request) => {
    const emailAccountId = request.auth.emailAccountId;
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
    const { limit, excludeExisting } = parsed.data;

    // Oversample — we may filter some out for canonicalization collisions or
    // excluded existing senders. 4x limit is plenty without being expensive.
    const oversample = limit * 4;

    const groups = await prisma.emailMessage.groupBy({
      by: ["from"],
      where: { emailAccountId, sent: false, draft: false },
      _count: { _all: true },
      _max: { date: true },
      orderBy: { _count: { from: "desc" } },
      take: oversample,
    });

    // Canonicalize and collapse (handles "Name" <a@b.com> vs a@b.com).
    type Bucket = {
      senderEmail: string;
      senderDomain: string;
      messageCount: number;
      lastSeenAt: Date | null;
    };
    const byEmail = new Map<string, Bucket>();
    for (const g of groups) {
      const canonical = canonicalizeSender(g.from);
      if (!canonical) continue;
      const domain = canonical.split("@")[1] ?? "";
      const existing = byEmail.get(canonical);
      if (existing) {
        existing.messageCount += g._count._all;
        if (
          g._max.date &&
          (!existing.lastSeenAt || g._max.date > existing.lastSeenAt)
        ) {
          existing.lastSeenAt = g._max.date;
        }
      } else {
        byEmail.set(canonical, {
          senderEmail: canonical,
          senderDomain: domain,
          messageCount: g._count._all,
          lastSeenAt: g._max.date ?? null,
        });
      }
    }

    let candidates = [...byEmail.values()].sort(
      (a, b) => b.messageCount - a.messageCount,
    );

    if (excludeExisting && candidates.length > 0) {
      const existing = await prisma.senderDecision.findMany({
        where: {
          emailAccountId,
          senderEmail: { in: candidates.map((c) => c.senderEmail) },
        },
        select: { senderEmail: true },
      });
      const have = new Set(existing.map((e) => e.senderEmail));
      candidates = candidates.filter((c) => !have.has(c.senderEmail));
    }

    const senders: TopSender[] = candidates.slice(0, limit).map((c) => ({
      senderEmail: c.senderEmail,
      senderDomain: c.senderDomain,
      messageCount: c.messageCount,
      lastSeenAt: c.lastSeenAt ? c.lastSeenAt.toISOString() : null,
    }));

    return NextResponse.json({ senders } satisfies GetTopSendersResponse);
  },
);
