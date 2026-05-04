import { NextResponse } from "next/server";
import { z } from "zod";
import type { SenderDecision } from "@/generated/prisma/client";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { logDecisionAudit } from "@/utils/sender-decision/audit";
import { canonicalizeSender, upsertDecision } from "@/utils/sender-decision";

export type ListSenderDecisionsResponse = {
  items: SenderDecision[];
  total: number;
};

const ACTIONS = [
  "auto_trash",
  "auto_archive",
  "always_keep",
  "review",
] as const;

const listQuerySchema = z.object({
  search: z.string().optional(),
  action: z.enum(ACTIONS).optional(),
  source: z.string().optional(),
  sort: z
    .enum(["messageCount", "lastSeenAt", "senderEmail", "updatedAt"])
    .default("messageCount"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withEmailAccount(
  "sender-decisions/list",
  async (request) => {
    const emailAccountId = request.auth.emailAccountId;
    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { search, action, source, sort, order, limit, offset } = parsed.data;

    const where = {
      emailAccountId,
      ...(action ? { action } : {}),
      ...(source ? { source } : {}),
      ...(search
        ? {
            OR: [
              { senderEmail: { contains: search.toLowerCase() } },
              { senderDomain: { contains: search.toLowerCase() } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.senderDecision.findMany({
        where,
        orderBy: [{ [sort]: order }],
        take: limit,
        skip: offset,
      }),
      prisma.senderDecision.count({ where }),
    ]);

    return NextResponse.json({
      items,
      total,
    } satisfies ListSenderDecisionsResponse);
  },
);

const createBodySchema = z.object({
  senderEmail: z.string().min(1),
  action: z.enum(ACTIONS).default("review"),
  note: z.string().optional(),
});

export const POST = withEmailAccount(
  "sender-decisions/create",
  async (request) => {
    const emailAccountId = request.auth.emailAccountId;
    const body = await request.json().catch(() => null);
    const parsed = createBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const canonical = canonicalizeSender(parsed.data.senderEmail);
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

    const after = await upsertDecision({
      emailAccountId,
      senderEmail: canonical,
      action: parsed.data.action,
      source: "user",
      note: parsed.data.note ?? null,
      protectUserDecisions: false, // explicit user action = overwrite
    });

    await logDecisionAudit({
      emailAccountId,
      senderEmail: canonical,
      before,
      after,
      actor: "user",
      action: before ? "update" : "create",
    });

    return NextResponse.json({ item: after });
  },
);
