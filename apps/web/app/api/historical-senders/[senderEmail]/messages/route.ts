import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getGmailAndAccessTokenForEmail } from "@/utils/email-account-client";
import { getMessages, getMessagesBatch } from "@/utils/gmail/message";
import { classifyGmailError, GmailErrorKind } from "@/utils/gmail/errors";
import {
  deriveSenderDrillLabelState,
  getCachedSenderDrill,
  invalidateSenderDrill,
  setCachedSenderDrill,
  type SenderDrillCachePayload,
  type SenderDrillLabelState,
  type SenderDrillMessage,
} from "@/utils/redis/sender-drill-cache";

/**
 * EL-362: Gmail live-fetch + Redis cache for SenderDetail drill-in.
 *
 * Replaces the previous pre-2024 only behavior \u2014 the caller needs to see
 * every past email from a sender to make an informed auto_trash /
 * auto_archive / keep decision, including mail older than the local
 * `EmailMessage` mirror covers.
 *
 * Read-only. No permanent deletes, no label mutations.
 */

const querySchema = z.object({
  cursor: z.string().optional(),
  // Legacy alias from the pre-EL-362 contract.
  pageToken: z.string().optional(),
  bypassCache: z
    .union([z.literal("0"), z.literal("1")])
    .optional()
    .transform((v) => v === "1"),
});

export type HistoricalSenderMessage = {
  id: string;
  threadId: string;
  date: string | null;
  subject: string;
  snippet: string;
  labelState: SenderDrillLabelState;
  /** Deprecated \u2014 kept for callers still reading the old flag. */
  inbox: boolean;
};

export type HistoricalSenderMessagesResponse = {
  messages: HistoricalSenderMessage[];
  nextPageToken: string | null;
  fromCache: boolean;
  fetchedAt: string;
  partial: boolean;
};

const PAGE_SIZE = 25;

function toResponseMessage(msg: SenderDrillMessage): HistoricalSenderMessage {
  return {
    id: msg.id,
    threadId: msg.threadId,
    date: msg.date,
    subject: msg.subject,
    snippet: msg.snippet,
    labelState: msg.labelState,
    inbox: msg.labelState === "inbox",
  };
}

export const GET = withEmailProvider(
  "historical-senders/messages",
  async (request, context) => {
    const { emailAccountId } = request.auth;
    const { emailProvider, logger } = request;

    if (!isGoogleProvider(emailProvider.name)) {
      return NextResponse.json(
        { error: "Only Gmail is supported.", isKnownError: true },
        { status: 400 },
      );
    }

    const params = await context.params;
    const senderEmail = decodeURIComponent(params.senderEmail);
    const { searchParams } = new URL(request.url);
    const parsed = querySchema.parse(Object.fromEntries(searchParams));
    const cursor = parsed.cursor ?? parsed.pageToken ?? null;
    const bypassCache = parsed.bypassCache ?? false;

    const cacheKeyParams = { emailAccountId, senderEmail, cursor };

    // Refresh path wipes every cached page for this sender before we fall
    // through to the live fetch. Matches the ticket's explicit invariant.
    if (bypassCache && cursor === null) {
      await invalidateSenderDrill({ emailAccountId, senderEmail });
    }

    if (!bypassCache) {
      const cached = await getCachedSenderDrill(cacheKeyParams);
      if (cached) {
        const response: HistoricalSenderMessagesResponse = {
          messages: cached.messages.map(toResponseMessage),
          nextPageToken: cached.nextPageToken,
          fromCache: true,
          fetchedAt: cached.fetchedAt,
          partial: cached.partial,
        };
        return NextResponse.json(response);
      }
    }

    const { gmail, accessToken } = await getGmailAndAccessTokenForEmail({
      emailAccountId,
      logger,
    });

    // Full-history query \u2014 inbox, archive, trash, sent. No date ceiling.
    const query = `from:${senderEmail}`;

    let ids: string[] = [];
    let nextPageToken: string | null = null;
    let partial = false;

    try {
      const list = await getMessages(gmail, {
        query,
        maxResults: PAGE_SIZE,
        pageToken: cursor ?? undefined,
      });
      ids = list.messages.map((m) => m.id);
      nextPageToken = list.nextPageToken ?? null;
    } catch (err) {
      const classification = classifyGmailError(err);
      if (classification.kind === GmailErrorKind.RATE_LIMITED) {
        logger.warn("drill_in.gmail_throttled", {
          senderEmail,
          stage: "list",
          accumulated: 0,
        });
        const payload: SenderDrillCachePayload = {
          messages: [],
          nextPageToken: null,
          fetchedAt: new Date().toISOString(),
          partial: true,
        };
        await setCachedSenderDrill(cacheKeyParams, payload);
        const response: HistoricalSenderMessagesResponse = {
          messages: [],
          nextPageToken: null,
          fromCache: false,
          fetchedAt: payload.fetchedAt,
          partial: true,
        };
        return NextResponse.json(response);
      }
      throw err;
    }

    let fetched: Awaited<ReturnType<typeof getMessagesBatch>> = [];
    if (ids.length) {
      try {
        fetched = await getMessagesBatch({ messageIds: ids, accessToken });
      } catch (err) {
        const classification = classifyGmailError(err);
        if (classification.kind === GmailErrorKind.RATE_LIMITED) {
          logger.warn("drill_in.gmail_throttled", {
            senderEmail,
            stage: "batch_get",
            accumulated: fetched.length,
          });
          partial = true;
        } else {
          throw err;
        }
      }
    }

    const messages: SenderDrillMessage[] = fetched.map((msg) => ({
      id: msg.id,
      threadId: msg.threadId,
      date: msg.headers?.date || null,
      subject: msg.headers?.subject || "",
      snippet: msg.snippet || "",
      labelState: deriveSenderDrillLabelState(msg.labelIds),
    }));

    const payload: SenderDrillCachePayload = {
      messages,
      nextPageToken,
      fetchedAt: new Date().toISOString(),
      partial,
    };
    await setCachedSenderDrill(cacheKeyParams, payload);

    const response: HistoricalSenderMessagesResponse = {
      messages: messages.map(toResponseMessage),
      nextPageToken,
      fromCache: false,
      fetchedAt: payload.fetchedAt,
      partial,
    };

    return NextResponse.json(response);
  },
);
