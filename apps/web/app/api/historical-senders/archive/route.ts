import { NextResponse } from "next/server";
import { z } from "zod";
import chunk from "lodash/chunk";
import { withEmailProvider } from "@/utils/middleware";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getGmailClientForEmail } from "@/utils/email-account-client";
import { getMessages } from "@/utils/gmail/message";
import { GmailLabel } from "@/utils/gmail/label";
import { withGmailRetry } from "@/utils/gmail/retry";
import prisma from "@/utils/prisma";

const bodySchema = z.object({
  senderEmails: z.array(z.string().min(1)).min(1).max(500),
});

export type HistoricalSendersArchiveResponse = {
  archived: { senderEmail: string; count: number }[];
};

const BATCH_MODIFY_CHUNK_SIZE = 1000;
const CUTOFF_QUERY = "before:2024/01/01";

export const POST = withEmailProvider(
  "historical-senders/archive",
  async (request) => {
    const { emailAccountId } = request.auth;
    const { emailProvider, logger } = request;

    if (!isGoogleProvider(emailProvider.name)) {
      return NextResponse.json(
        { error: "Only Gmail is supported.", isKnownError: true },
        { status: 400 },
      );
    }

    const body = bodySchema.parse(await request.json());
    const gmail = await getGmailClientForEmail({ emailAccountId, logger });

    const archived: { senderEmail: string; count: number }[] = [];

    for (const senderEmail of body.senderEmails) {
      let archivedCount = 0;
      let pageToken: string | undefined;
      const query = `from:${senderEmail} ${CUTOFF_QUERY} in:inbox`;

      do {
        const { messages, nextPageToken } = await getMessages(gmail, {
          query,
          maxResults: 500,
          pageToken,
        });

        const ids = messages.map((m) => m.id).filter(Boolean);
        if (ids.length > 0) {
          for (const slice of chunk(ids, BATCH_MODIFY_CHUNK_SIZE)) {
            await withGmailRetry(() =>
              gmail.users.messages.batchModify({
                userId: "me",
                requestBody: {
                  ids: slice,
                  removeLabelIds: [GmailLabel.INBOX],
                },
              }),
            );
            archivedCount += slice.length;
          }
        }

        pageToken = nextPageToken;
      } while (pageToken);

      await prisma.historicalSender
        .update({
          where: {
            emailAccountId_senderEmail: {
              emailAccountId,
              senderEmail,
            },
          },
          data: { archivedAt: new Date(), skippedAt: null },
        })
        .catch((error) => {
          logger.warn("Failed to mark sender archived", {
            senderEmail,
            error,
          });
        });

      archived.push({ senderEmail, count: archivedCount });
    }

    const response: HistoricalSendersArchiveResponse = { archived };
    return NextResponse.json(response);
  },
);
