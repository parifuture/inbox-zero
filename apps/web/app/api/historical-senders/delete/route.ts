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
import prisma from "@/utils/prisma";

// EL-438 — Move-to-Trash for Historical Cleanup.
//
// Semantics: this is a SOFT delete. Gmail keeps trashed mail for 30 days, so
// the user can recover anything we touch by going to Gmail → Trash. We never
// call `messages.delete` (permanent delete) — only `batchModify` to add the
// TRASH label.
//
// Safety: we reuse `buildArchiveQuery`, which already excludes
// `in:sent`, `in:trash`, and `is:starred` (per EL-323 + EL-432). Starred
// threads can never be moved to Trash via this endpoint, mirroring the
// archive route's defence-in-depth.

const bodySchema = z.object({
  senderEmails: z.array(z.string().min(1)).min(1).max(500),
});

export type HistoricalSendersDeleteResponse = {
  trashed: { senderEmail: string; count: number }[];
};

const BATCH_MODIFY_CHUNK_SIZE = 1000;

export const POST = withEmailProvider(
  "historical-senders/delete",
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

    const trashed: { senderEmail: string; count: number }[] = [];

    for (const senderEmail of body.senderEmails) {
      let trashedCount = 0;
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
                    addLabelIds: [GmailLabel.TRASH],
                    removeLabelIds: [GmailLabel.INBOX],
                  },
                }),
              {
                op: "batch_trash",
                targetId: `sender:${senderEmail}:${slice.length}`,
                downgradeNotFound: true,
              },
            );
            trashedCount += slice.length;
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
          data: {
            deletedAt: new Date(),
            archivedAt: null,
            skippedAt: null,
          },
        })
        .catch((error) => {
          logger.warn("Failed to mark sender deleted", {
            senderEmail,
            error,
          });
        });

      trashed.push({ senderEmail, count: trashedCount });
    }

    const response: HistoricalSendersDeleteResponse = { trashed };
    return NextResponse.json(response);
  },
);
