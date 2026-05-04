/**
 * EL-358b \u2014 build `SenderAggregate` from fork EmailMessage rollups.
 *
 * The sidecar used a bespoke `sender_aggregates` Postgres table. In the fork
 * we avoid adding a new ingestion path: every inbound/outbound message
 * already lands in `EmailMessage`, and `ResponseTime` already tracks
 * sent\u2192received pairings for the reply-tracker. We re-derive the four
 * signals the scorer needs (reply_count, last_replied, volume, initiation)
 * from those two tables on demand.
 *
 * Reads only. No writes. No Gmail calls. The returned shape matches the
 * pure-function contract defined in `types.ts` so the scorer can consume it
 * unchanged.
 */

import prisma from "@/utils/prisma";
import type { SenderAggregate } from "./types";

/**
 * Compute a `SenderAggregate` for a single sender from existing fork tables.
 *
 * Returns `null` if we've never seen a message from this sender \u2014 this is
 * the cold-start case that the scorer handles with `domain_prior`.
 *
 * Inputs are assumed to be canonicalised (lowercase addr-spec). Callers
 * that have a raw `From:` header should extract via `extractEmailAddress`
 * and lowercase before calling.
 */
export async function buildSenderAggregate(
  emailAccountId: string,
  senderEmail: string,
): Promise<SenderAggregate | null> {
  // Received: inbound messages from this sender.
  const receivedAgg = await prisma.emailMessage.aggregate({
    where: { emailAccountId, from: senderEmail, sent: false },
    _count: { _all: true },
    _min: { date: true },
    _max: { date: true },
  });

  const totalReceivedFrom = receivedAgg._count._all;
  const firstSeen = receivedAgg._min.date;
  const lastReceived = receivedAgg._max.date;

  // Sent: outbound messages addressed to this sender. `EmailMessage.to`
  // is stored as a single delimited string in the fork, so we do a
  // substring match. Cheap compared to parsing every row.
  const totalSentToThem = await prisma.emailMessage.count({
    where: {
      emailAccountId,
      sent: true,
      to: { contains: senderEmail, mode: "insensitive" },
    },
  });

  if (totalReceivedFrom === 0 && totalSentToThem === 0) {
    return null;
  }

  // Reply signals: join via ResponseTime. A reply row exists when we sent
  // something in response to a received message; pulling the receivedAt
  // side back to an EmailMessage.from is accurate but expensive, so we
  // approximate by filtering ResponseTime via the received message's id.
  //
  // This two-step query keeps the inner set small: first get the Gmail
  // message ids for this sender (bounded by totalReceivedFrom, which is
  // usually tiny), then count ResponseTime rows whose receivedMessageId
  // is in that set.
  let replyCount = 0;
  let lastReplied: Date | null = null;
  if (totalReceivedFrom > 0) {
    const receivedIds = await prisma.emailMessage.findMany({
      where: { emailAccountId, from: senderEmail, sent: false },
      select: { messageId: true },
    });
    const ids = receivedIds.map((r) => r.messageId);
    if (ids.length > 0) {
      const replyAgg = await prisma.responseTime.aggregate({
        where: { emailAccountId, receivedMessageId: { in: ids } },
        _count: { _all: true },
        _max: { sentAt: true },
      });
      replyCount = replyAgg._count._all;
      lastReplied = replyAgg._max.sentAt;
    }
  }

  const initiationDenominator = totalSentToThem + totalReceivedFrom;
  const initiationRatio =
    initiationDenominator === 0 ? 0.5 : totalSentToThem / initiationDenominator;

  const domain = senderEmail.split("@")[1]?.toLowerCase() ?? "";

  return {
    address: senderEmail,
    domain,
    firstSeen,
    initiationRatio,
    lastReceived,
    lastReplied,
    replyCount,
    totalReceivedFrom,
    totalSentToThem,
  };
}
