import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import type { Prisma } from "@/generated/prisma/client";

const querySchema = z.object({
  search: z.string().optional(),
  minCount: z.coerce.number().int().min(1).default(1),
  sort: z.enum(["count", "lastDate", "firstDate"]).default("count"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["active", "archived", "skipped", "all"]).default("active"),
});

export type HistoricalSendersQuery = z.infer<typeof querySchema>;

export type HistoricalSenderItem = {
  id: string;
  senderEmail: string;
  senderName: string | null;
  domain: string;
  count: number;
  firstDate: string;
  lastDate: string;
  archivedAt: string | null;
  skippedAt: string | null;
};

export type HistoricalSendersResponse = {
  senders: HistoricalSenderItem[];
  total: number;
};

function buildWhere(
  emailAccountId: string,
  params: HistoricalSendersQuery,
): Prisma.HistoricalSenderWhereInput {
  const where: Prisma.HistoricalSenderWhereInput = {
    emailAccountId,
    count: { gte: params.minCount },
  };

  switch (params.status) {
    case "active":
      where.archivedAt = null;
      where.skippedAt = null;
      break;
    case "archived":
      where.archivedAt = { not: null };
      break;
    case "skipped":
      where.skippedAt = { not: null };
      break;
    case "all":
      break;
  }

  if (params.search) {
    const search = params.search;
    where.OR = [
      { senderEmail: { contains: search, mode: "insensitive" } },
      { senderName: { contains: search, mode: "insensitive" } },
      { domain: { contains: search, mode: "insensitive" } },
    ];
  }

  return where;
}

export const GET = withEmailAccount(
  "historical-senders/list",
  async (request) => {
    const { emailAccountId } = request.auth;
    const { searchParams } = new URL(request.url);
    const params = querySchema.parse(Object.fromEntries(searchParams));

    const where = buildWhere(emailAccountId, params);

    const [senders, total] = await Promise.all([
      prisma.historicalSender.findMany({
        where,
        orderBy: { [params.sort]: params.order },
        take: params.limit,
        skip: params.offset,
      }),
      prisma.historicalSender.count({ where }),
    ]);

    const response: HistoricalSendersResponse = {
      senders: senders.map((s) => ({
        id: s.id,
        senderEmail: s.senderEmail,
        senderName: s.senderName,
        domain: s.domain,
        count: s.count,
        firstDate: s.firstDate.toISOString(),
        lastDate: s.lastDate.toISOString(),
        archivedAt: s.archivedAt?.toISOString() ?? null,
        skippedAt: s.skippedAt?.toISOString() ?? null,
      })),
      total,
    };

    return NextResponse.json(response);
  },
);
