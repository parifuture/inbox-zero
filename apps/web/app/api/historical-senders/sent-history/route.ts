import { NextResponse } from "next/server";
import chunk from "lodash/chunk";
import { z } from "zod";
import { withEmailProvider, withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getGmailClientForEmail } from "@/utils/email-account-client";
import { getMessages } from "@/utils/gmail/message";
import { GmailLabel } from "@/utils/gmail/label";
import { runGmailOp } from "@/utils/gmail/errors";
import { buildArchiveQuery } from "@/app/api/historical-senders/scan-runner";
import { extractDomainFromEmail } from "@/utils/email";
import {
  classifyExclusion,
  type ExclusionReason,
} from "@/utils/sent-history/exclusion-rules";
import { getKillSwitchStatus } from "@/utils/kill-switch";
import { createScopedLogger } from "@/utils/logger";

// ---------------------------------------------------------------------------
// Types — exported so the frontend can import them.
// ---------------------------------------------------------------------------

export type SentHistorySender = {
  senderEmail: string;
  senderDomain: string;
  senderName: string | null;
  sentToThemCount: number;
  lastSentToThem: string | null;
  lastReceivedFrom: string | null;
  receivedCount: number;
  category: string | null;
  exclusionReason: ExclusionReason | null;
  excluded: boolean;
};

export type SentHistoryResponse = {
  senders: SentHistorySender[];
  totals: {
    candidates: number;
    willArchive: number;
    willKeep: number;
    byReason: Record<ExclusionReason, number>;
  };
  killSwitchPaused: boolean;
};

export type SentHistoryArchiveRequest = {
  senderEmails: string[];
  excludeSenderEmails?: string[];
};

export type SentHistoryArchiveResponse = {
  archived: { senderEmail: string; count: number }[];
  excluded: number;
  killSwitchPaused?: boolean;
};

// ---------------------------------------------------------------------------
// Raw-SQL row types — sender_truth + vip_senders + sender_aggregates live
// outside Prisma schema (sidecar-managed) so we use $queryRaw.
// ---------------------------------------------------------------------------

type SenderTruthRow = {
  sender_email: string;
  category: string;
  action: string;
  evidence: {
    sent_count?: number | null;
    last_sent?: string | null;
    first_sent?: string | null;
  } | null;
};

type SenderAggregateRow = {
  address: string;
  total_received_from: number | null;
  last_received: string | null;
};

type VipRow = { address: string | null; domain: string | null };

// ---------------------------------------------------------------------------
// GET — list senders with exclusion flags
// ---------------------------------------------------------------------------

export const GET = withEmailAccount(
  "historical-senders/sent-history/list",
  async (request) => {
    const { emailAccountId } = request.auth;

    // 1. sender_truth — only rows still pending an action (action='archive').
    //    Anything Chotu has already kept (action='keep') is filtered out.
    const truth = await prisma.$queryRaw<SenderTruthRow[]>`
      SELECT sender_email, category, action, evidence
      FROM sender_truth
      WHERE action = 'archive'
    `;
    const senderEmails = truth.map((t) => t.sender_email.toLowerCase());

    // 2. sender_aggregates for received-from signal. Bulk fetch by IN(...).
    const aggregates =
      senderEmails.length === 0
        ? []
        : await prisma.$queryRaw<SenderAggregateRow[]>`
            SELECT address, total_received_from, last_received
            FROM sender_aggregates
            WHERE address = ANY(${senderEmails}::text[])
          `;
    const aggByEmail = new Map(
      aggregates.map((a) => [a.address.toLowerCase(), a]),
    );

    // 3. vip_senders — both per-address and per-domain.
    const vips = await prisma.$queryRaw<VipRow[]>`
      SELECT address, domain FROM vip_senders
    `;
    const vipAddresses = new Set(
      vips
        .map((v) => v.address?.toLowerCase())
        .filter((a): a is string => Boolean(a)),
    );
    const vipDomains = new Set(
      vips
        .map((v) => v.domain?.toLowerCase())
        .filter((d): d is string => Boolean(d)),
    );

    // 4. Newsletter — categories + display names (per-email-account).
    const newsletters = await prisma.newsletter.findMany({
      where: {
        emailAccountId,
        email: { in: senderEmails },
      },
      include: { category: { select: { name: true } } },
    });
    const newsByEmail = new Map(
      newsletters.map((n) => [n.email.toLowerCase(), n]),
    );

    const now = new Date();
    const senders: SentHistorySender[] = truth.map((t) => {
      const senderEmail = t.sender_email.toLowerCase();
      const senderDomain = extractDomainFromEmail(senderEmail);
      const agg = aggByEmail.get(senderEmail);
      const news = newsByEmail.get(senderEmail);

      const isVip =
        vipAddresses.has(senderEmail) ||
        (!!senderDomain && vipDomains.has(senderDomain));

      const lastSentToThem = t.evidence?.last_sent ?? null;
      const lastReceivedFrom = agg?.last_received ?? null;

      const exclusionReason = classifyExclusion({
        senderEmail,
        senderDomain,
        lastReceivedAt: lastReceivedFrom,
        lastSentAt: lastSentToThem,
        isVip,
        now,
      });

      return {
        senderEmail,
        senderDomain,
        senderName: news?.name ?? null,
        sentToThemCount: t.evidence?.sent_count ?? 0,
        lastSentToThem,
        lastReceivedFrom,
        receivedCount: agg?.total_received_from ?? 0,
        category: news?.category?.name ?? null,
        exclusionReason,
        excluded: exclusionReason !== null,
      };
    });

    // Stable sort: excluded last, otherwise by received count desc, then alpha.
    senders.sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      if (a.receivedCount !== b.receivedCount)
        return b.receivedCount - a.receivedCount;
      return a.senderEmail.localeCompare(b.senderEmail);
    });

    const byReason: Record<ExclusionReason, number> = {
      vip: 0,
      active_thread: 0,
      protected_class: 0,
      ad_site: 0,
      careers: 0,
      personal_domain: 0,
    };
    for (const s of senders) {
      if (s.exclusionReason) byReason[s.exclusionReason] += 1;
    }

    const willKeep = senders.filter((s) => s.excluded).length;
    const willArchive = senders.length - willKeep;

    const killSwitch = await getKillSwitchStatus(emailAccountId).catch(() => ({
      paused: false,
    }));

    const response: SentHistoryResponse = {
      senders,
      totals: {
        candidates: senders.length,
        willArchive,
        willKeep,
        byReason,
      },
      killSwitchPaused: killSwitch.paused,
    };
    return NextResponse.json(response);
  },
);

// ---------------------------------------------------------------------------
// POST — archive selected senders + write `sender_truth.action='keep'` for the
// excluded ones so we don't re-suggest them.
// ---------------------------------------------------------------------------

const archiveBodySchema = z.object({
  senderEmails: z.array(z.string().min(1)).max(500),
  excludeSenderEmails: z.array(z.string().min(1)).max(2000).optional(),
});

const BATCH_MODIFY_CHUNK_SIZE = 1000;

const log = createScopedLogger("historical-senders/sent-history");

export const POST = withEmailProvider(
  "historical-senders/sent-history/archive",
  async (request) => {
    const { emailAccountId } = request.auth;
    const { emailProvider, logger } = request;

    if (!isGoogleProvider(emailProvider.name)) {
      return NextResponse.json(
        { error: "Only Gmail is supported.", isKnownError: true },
        { status: 400 },
      );
    }

    const body = archiveBodySchema.parse(await request.json());

    // EL-370 kill-switch — refuse to archive when paused. Surface as a
    // structured response, not a 500. UI shows an explicit paused banner.
    const killSwitch = await getKillSwitchStatus(emailAccountId).catch(() => ({
      paused: false,
    }));
    if (killSwitch.paused) {
      return NextResponse.json<SentHistoryArchiveResponse>(
        { archived: [], excluded: 0, killSwitchPaused: true },
        { status: 200 },
      );
    }

    const senderEmails = Array.from(
      new Set(body.senderEmails.map((s) => s.toLowerCase())),
    );
    const excludeSenderEmails = Array.from(
      new Set((body.excludeSenderEmails ?? []).map((s) => s.toLowerCase())),
    );

    const gmail = await getGmailClientForEmail({ emailAccountId, logger });
    const archived: { senderEmail: string; count: number }[] = [];

    for (const senderEmail of senderEmails) {
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

      // Mirror existing /archive endpoint: best-effort write to HistoricalSender
      // so the UI badges line up. Not required for correctness.
      await prisma.historicalSender
        .updateMany({
          where: { emailAccountId, senderEmail },
          data: { archivedAt: new Date(), skippedAt: null },
        })
        .catch(() => undefined);

      // Persistent decision: write sender_truth.action='keep' would be wrong here;
      // we just archived, so leave action='archive' alone (action represents the
      // intent that was already executed). Action='keep' is reserved for the
      // explicit-keep path below.
      archived.push({ senderEmail, count: archivedCount });
    }

    // Persistent keep — write `action='keep'` for everything Chotu opted out
    // of so re-running doesn't re-suggest them.
    let excludedWritten = 0;
    if (excludeSenderEmails.length > 0) {
      try {
        const result = await prisma.$executeRaw`
          UPDATE sender_truth
          SET action = 'keep', updated_at = now()
          WHERE sender_email = ANY(${excludeSenderEmails}::text[])
        `;
        excludedWritten = Number(result) || 0;
      } catch (error) {
        logger.warn("Failed to mark senders as keep", { error });
      }
    }

    log.info("bulk_archive.sent_history", {
      emailAccountId,
      archived: archived.length,
      archivedMessages: archived.reduce((acc, a) => acc + a.count, 0),
      excluded: excludedWritten,
    });

    const response: SentHistoryArchiveResponse = {
      archived,
      excluded: excludedWritten,
    };
    return NextResponse.json(response);
  },
);
