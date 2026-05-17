import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getGmailClientForEmail } from "@/utils/email-account-client";
import { getMessages } from "@/utils/gmail/message";
import { runGmailOp } from "@/utils/gmail/errors";
import { buildArchiveQuery } from "@/app/api/historical-senders/scan-runner";
import { getKillSwitchStatus } from "@/utils/kill-switch";
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
  killSwitchPaused?: boolean;
};

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

    // EL-370 kill-switch — refuse to trash when autonomous actions are
    // paused. Delete is the largest blast-radius human-driven action; it must
    // respect the same pause as autonomous flows. Recovery (undo) remains
    // available even when paused.
    const killSwitch = await getKillSwitchStatus(emailAccountId).catch(() => ({
      paused: false,
    }));
    if (killSwitch.paused) {
      return NextResponse.json<HistoricalSendersDeleteResponse>(
        { trashed: [], killSwitchPaused: true },
        { status: 200 },
      );
    }

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

        // EL-459: Use users.messages.trash (the proper Gmail 'move to
        // Trash' API) instead of batchModify+addLabelIds:[TRASH]. Adding the
        // TRASH label via batchModify is unreliable — Gmail accepts the
        // mutation but doesn't always actually move the message to Trash.
        // messages.trash guarantees the message shows up in the user's
        // Trash folder. NEVER call messages.delete (permanent).
        for (const msg of messages) {
          if (!msg.id) continue;
          await runGmailOp(
            () =>
              gmail.users.messages.trash({
                userId: "me",
                id: msg.id!,
              }),
            {
              op: "trash_message",
              targetId: `sender:${senderEmail}:msg:${msg.id}`,
              downgradeNotFound: true,
            },
          );
          trashedCount += 1;
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
