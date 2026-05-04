import { NextResponse } from "next/server";
import { z } from "zod";
import type { EmailMessage } from "@/generated/prisma/client";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { canonicalizeSender } from "@/utils/sender-decision";

export type SenderMessagesResponse = {
  items: EmailMessage[];
  total: number;
  source: "local" | "gmail-mirror";
};

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withEmailAccount(
  "sender-decisions/messages",
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
      return NextResponse.json({ error: "Invalid query" }, { status: 400 });
    }
    const { limit, offset } = parsed.data;

    const where = {
      emailAccountId,
      // Local `EmailMessage.from` may include display names; match by substring.
      from: { contains: canonical },
    };

    const [items, total] = await Promise.all([
      prisma.emailMessage.findMany({
        where,
        orderBy: { date: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.emailMessage.count({ where }),
    ]);

    // NOTE: gmail-mirror SQLite fallback is deferred to a follow-up ticket.
    // For now we only return locally-synced messages.
    return NextResponse.json({
      items,
      total,
      source: "local",
    } satisfies SenderMessagesResponse);
  },
);
