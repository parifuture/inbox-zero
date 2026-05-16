import { NextResponse } from "next/server";
import { z } from "zod";
import chunk from "lodash/chunk";
import { withEmailProvider } from "@/utils/middleware";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getGmailClientForEmail } from "@/utils/email-account-client";
import { getMessages } from "@/utils/gmail/message";
import { GmailLabel } from "@/utils/gmail/label";
import { runGmailOp } from "@/utils/gmail/errors";
import { buildArchiveQuery } from "@/app/api/historical-senders/scan-runner";
import { getKillSwitchStatus } from "@/utils/kill-switch";
import prisma from "@/utils/prisma";

const bodySchema = z.object({
  senderEmails: z.array(z.string().min(1)).min(1).max(500),
});

export type HistoricalSendersArchiveResponse = {
  archived: { senderEmail: string; count: number }[];
  killSwitchPaused?: boolean;
};

const BATCH_MODIFY_CHUNK_SIZE = 1000;

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

    // EL-370 kill-switch — refuse to archive when autonomous actions are
    // paused. Bulk human-driven archive can move thousands of messages, so
    // it must respect the same pause as autonomous flows. Recovery (undo)
    // remains available even when paused.
    const killSwitch = await getKillSwitchStatus(emailAccountId).catch(() => ({
      paused: false,
    }));
    if (killSwitch.paused) {
      return NextResponse.json<HistoricalSendersArchiveResponse>(
        { archived: [], killSwitchPaused: true },
        { status: 200 },
      );
    }

    const gmail = await getGmailClientForEmail({ emailAccountId, logger });

    const archived: { senderEmail: string; count: number }[] = [];

    for (const senderEmail of body.senderEmails) {
      let archivedCount = 0;
      let pageToken: string | undefined;
      const query = buildArchiveQuery(senderEmail);

      do {
        const { messages, nextPageToken } = await getMessages(gmail, {
          query,
          maxResults: 500,
          pageToken,
        });

        const ids = messages.map((m) => m.id).filter(Boolean);
        if (ids.length > 0) {
          for (const slice of chunk(ids, BATCH_MODIFY_CHUNK_SIZE)) {
            await runGmailOp(
              () =>
                gmail.users.messages.batchModify({
                  userId: "me",
                  requestBody: {
                    ids: slice,
                    removeLabelIds: [GmailLabel.INBOX],
                  },
                }),
              {
                op: "batch_archive",
                targetId: `sender:${senderEmail}:${slice.length}`,
                downgradeNotFound: true,
              },
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
