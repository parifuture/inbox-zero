import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getGmailAndAccessTokenForEmail } from "@/utils/email-account-client";
import { getMessages, getMessagesBatch } from "@/utils/gmail/message";
import { GmailLabel } from "@/utils/gmail/label";

const querySchema = z.object({
  pageToken: z.string().optional(),
});

export type HistoricalSenderMessage = {
  id: string;
  threadId: string;
  date: string | null;
  subject: string;
  snippet: string;
  inbox: boolean;
};

export type HistoricalSenderMessagesResponse = {
  messages: HistoricalSenderMessage[];
  nextPageToken: string | null;
};

const CUTOFF_QUERY = "before:2024/01/01";

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
    const { pageToken } = querySchema.parse(Object.fromEntries(searchParams));

    const { gmail, accessToken } = await getGmailAndAccessTokenForEmail({
      emailAccountId,
      logger,
    });

    const query = `from:${senderEmail} ${CUTOFF_QUERY}`;
    const list = await getMessages(gmail, {
      query,
      maxResults: 25,
      pageToken,
    });

    const ids = list.messages.map((m) => m.id);
    const fetched = ids.length
      ? await getMessagesBatch({ messageIds: ids, accessToken })
      : [];

    const messages: HistoricalSenderMessage[] = fetched.map((msg) => ({
      id: msg.id,
      threadId: msg.threadId,
      date: msg.headers?.date || null,
      subject: msg.headers?.subject || "",
      snippet: msg.snippet || "",
      inbox: Array.isArray(msg.labelIds)
        ? msg.labelIds.includes(GmailLabel.INBOX)
        : false,
    }));

    const response: HistoricalSenderMessagesResponse = {
      messages,
      nextPageToken: list.nextPageToken ?? null,
    };

    return NextResponse.json(response);
  },
);
