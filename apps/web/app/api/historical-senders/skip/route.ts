import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";

const bodySchema = z.object({
  senderEmails: z.array(z.string().min(1)).min(1).max(500),
});

export type HistoricalSendersSkipResponse = { skipped: number };

export const POST = withEmailAccount(
  "historical-senders/skip",
  async (request) => {
    const { emailAccountId } = request.auth;
    const body = bodySchema.parse(await request.json());

    const result = await prisma.historicalSender.updateMany({
      where: {
        emailAccountId,
        senderEmail: { in: body.senderEmails },
      },
      data: { skippedAt: new Date() },
    });

    const response: HistoricalSendersSkipResponse = { skipped: result.count };
    return NextResponse.json(response);
  },
);
