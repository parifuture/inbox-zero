import type { gmail_v1 } from "@googleapis/gmail";
import prisma from "@/utils/prisma";
import { getMessagesBatch } from "@/utils/gmail/message";
import { getAccessTokenFromClient } from "@/utils/gmail/client";
import { extractEmailAddress, extractDomainFromEmail } from "@/utils/email";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("historical-senders/scan");

const PAGE_SIZE = 500;
const PROGRESS_FLUSH_EVERY_PAGES = 1;

type SenderAggregate = {
  senderEmail: string;
  senderName: string | null;
  domain: string;
  count: number;
  firstDate: Date;
  lastDate: Date;
};

function parseFromHeader(header: string): {
  email: string;
  name: string | null;
} {
  const email = extractEmailAddress(header);
  if (!email) return { email: "", name: null };

  // "Display Name" <email> | Display Name <email> | <email> | email
  const match = header.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  const rawName = match?.[1]?.trim();
  const name =
    rawName && rawName.toLowerCase() !== email.toLowerCase() ? rawName : null;
  return { email, name };
}

function parseDateHeader(header: string | undefined): Date | null {
  if (!header) return null;
  const ts = Date.parse(header);
  return Number.isNaN(ts) ? null : new Date(ts);
}

async function flushAggregates(
  emailAccountId: string,
  aggregates: Map<string, SenderAggregate>,
) {
  if (aggregates.size === 0) return;

  for (const agg of aggregates.values()) {
    await prisma.historicalSender.upsert({
      where: {
        emailAccountId_senderEmail: {
          emailAccountId,
          senderEmail: agg.senderEmail,
        },
      },
      create: {
        emailAccountId,
        senderEmail: agg.senderEmail,
        senderName: agg.senderName,
        domain: agg.domain,
        count: agg.count,
        firstDate: agg.firstDate,
        lastDate: agg.lastDate,
      },
      update: {
        count: { increment: agg.count },
        firstDate: agg.firstDate, // will be reconciled below
        lastDate: agg.lastDate,
        senderName: agg.senderName ?? undefined,
      },
    });

    // Reconcile firstDate (min) and lastDate (max) — Prisma doesn't have min/max upsert
    await prisma.$executeRaw`
      UPDATE "HistoricalSender"
      SET
        "firstDate" = LEAST("firstDate", ${agg.firstDate}::timestamp),
        "lastDate"  = GREATEST("lastDate", ${agg.lastDate}::timestamp)
      WHERE "emailAccountId" = ${emailAccountId}
        AND "senderEmail" = ${agg.senderEmail}
    `;
  }
}

export async function scanHistoricalSenders({
  emailAccountId,
  gmail,
  cutoffDate,
}: {
  emailAccountId: string;
  gmail: gmail_v1.Gmail;
  cutoffDate: Date;
}) {
  const log = logger.with({ emailAccountId });
  log.info("Starting historical sender scan", { cutoffDate });

  // Format: YYYY/MM/DD as Gmail expects
  const yyyy = cutoffDate.getUTCFullYear();
  const mm = String(cutoffDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(cutoffDate.getUTCDate()).padStart(2, "0");
  const query = `before:${yyyy}/${mm}/${dd}`;

  const accessToken = getAccessTokenFromClient(gmail);

  let pageToken: string | undefined;
  let totalProcessed = 0;
  let pageCount = 0;
  let totalEstimateRecorded = false;

  try {
    do {
      const listResp = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: PAGE_SIZE,
        pageToken,
      });

      const messages = listResp.data.messages || [];
      pageToken = listResp.data.nextPageToken || undefined;

      if (!totalEstimateRecorded) {
        const totalEstimate = listResp.data.resultSizeEstimate ?? null;
        await prisma.historicalSenderScan.update({
          where: { emailAccountId },
          data: { totalEstimate: totalEstimate ?? undefined },
        });
        totalEstimateRecorded = true;
      }

      if (messages.length === 0) {
        break;
      }

      const messageIds = messages
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id));

      // Fetch metadata-format messages in chunks of <=100 (batch limit)
      const aggregates = new Map<string, SenderAggregate>();
      const CHUNK = 100;
      for (let i = 0; i < messageIds.length; i += CHUNK) {
        const slice = messageIds.slice(i, i + CHUNK);
        const fetched = await getMessagesBatch({
          messageIds: slice,
          accessToken,
        });
        for (const msg of fetched) {
          const fromHeader = msg.headers?.from;
          if (!fromHeader) continue;
          const { email, name } = parseFromHeader(fromHeader);
          if (!email) continue;

          const dateHeader = msg.headers?.date;
          const date =
            parseDateHeader(dateHeader) ??
            (msg.internalDate ? new Date(Number(msg.internalDate)) : null);
          if (!date) continue;

          const lower = email.toLowerCase();
          const existing = aggregates.get(lower);
          if (existing) {
            existing.count += 1;
            if (date < existing.firstDate) existing.firstDate = date;
            if (date > existing.lastDate) existing.lastDate = date;
            if (!existing.senderName && name) existing.senderName = name;
          } else {
            aggregates.set(lower, {
              senderEmail: lower,
              senderName: name,
              domain: extractDomainFromEmail(email).toLowerCase(),
              count: 1,
              firstDate: date,
              lastDate: date,
            });
          }
        }
      }

      await flushAggregates(emailAccountId, aggregates);

      totalProcessed += messageIds.length;
      pageCount += 1;

      if (pageCount % PROGRESS_FLUSH_EVERY_PAGES === 0) {
        await prisma.historicalSenderScan.update({
          where: { emailAccountId },
          data: { progress: totalProcessed },
        });
      }
    } while (pageToken);

    await prisma.historicalSenderScan.update({
      where: { emailAccountId },
      data: {
        status: "completed",
        progress: totalProcessed,
        completedAt: new Date(),
        error: null,
      },
    });
    log.info("Historical sender scan completed", { totalProcessed });
  } catch (error) {
    log.error("Historical sender scan failed", { error });
    await prisma.historicalSenderScan
      .update({
        where: { emailAccountId },
        data: {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      })
      .catch(() => undefined);
  }
}
