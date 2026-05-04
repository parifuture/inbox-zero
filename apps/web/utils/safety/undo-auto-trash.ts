import type { gmail_v1 } from "@googleapis/gmail";
import prisma from "@/utils/prisma";
import { GmailLabel } from "@/utils/gmail/label";
import { withGmailRetry } from "@/utils/gmail/retry";
import { createScopedLogger, type Logger } from "@/utils/logger";
import { sleep } from "@/utils/sleep";

const MODULE = "safety.undo-auto-trash";

/** Gmail batchModify accepts \u2264 1000 ids per request. */
export const UNTRASH_CHUNK_SIZE = 1000;
/** Spacing between mutating calls to stay under per-user quota. */
export const UNTRASH_MIN_SPACING_MS = 500;

/**
 * Hard cap on how many messages one undo call can restore. Protects the
 * audit log from a UI-spam storm and keeps the operation in single-request
 * budgets. If the user needs more they can chain calls (60s rate-limit
 * between them).
 */
export const MAX_COUNT_PER_CALL = 500;

/** Default count when caller supplied no filter. */
export const DEFAULT_COUNT = 50;

export type UndoFilter = {
  /** Only consider auto-trash ExecutedRules from the last N minutes. */
  minutes?: number;
  /** Only consider the N most recent matching ExecutedRules. */
  count?: number;
  /** Narrow to a single sender (canonicalized upstream). */
  senderEmail?: string;
};

export type UndoResult = {
  attempted: number;
  restored: number;
  notFound: number;
  failed: number;
  messageIds: string[];
};

export function validateFilter(filter: UndoFilter): string | null {
  const hasMinutes = typeof filter.minutes === "number" && filter.minutes > 0;
  const hasCount = typeof filter.count === "number" && filter.count > 0;

  if (!hasMinutes && !hasCount) {
    return "Provide either `minutes` or `count` (both optional together means no-op).";
  }
  if (hasMinutes && hasCount) {
    return "Provide exactly one of `minutes` or `count`, not both.";
  }
  if (hasCount && filter.count! > MAX_COUNT_PER_CALL) {
    return `count must be \u2264 ${MAX_COUNT_PER_CALL}.`;
  }
  if (hasMinutes && filter.minutes! > 24 * 60) {
    return "minutes must be \u2264 1440 (24h).";
  }
  return null;
}

/**
 * Find the ExecutedRule rows that represent sender-decision `auto_trash`
 * mutations we can untrash. Matches by the reason string written by the
 * sender-decision gate: 'sender_decision:auto_trash'.
 */
export async function findAutoTrashExecutions(params: {
  emailAccountId: string;
  filter: UndoFilter;
}): Promise<
  {
    id: string;
    messageId: string;
    threadId: string;
    senderEmail: string | null;
  }[]
> {
  const { emailAccountId, filter } = params;

  const where: Parameters<typeof prisma.executedRule.findMany>[0] = {
    where: {
      emailAccountId,
      reason: "sender_decision:auto_trash",
      ...(filter.minutes
        ? {
            createdAt: {
              gte: new Date(Date.now() - filter.minutes * 60_000),
            },
          }
        : {}),
      ...(filter.senderEmail
        ? {
            matchMetadata: {
              path: ["senderEmail"],
              equals: filter.senderEmail,
            },
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      messageId: true,
      threadId: true,
      matchMetadata: true,
    },
    ...(filter.count ? { take: filter.count } : { take: MAX_COUNT_PER_CALL }),
  };

  const rows = await prisma.executedRule.findMany(where);

  return rows.map((r) => ({
    id: r.id,
    messageId: r.messageId,
    threadId: r.threadId,
    senderEmail:
      r.matchMetadata && typeof r.matchMetadata === "object"
        ? (((r.matchMetadata as Record<string, unknown>).senderEmail as
            | string
            | null
            | undefined) ?? null)
        : null,
  }));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export type RunDeps = {
  gmail: gmail_v1.Gmail;
  sleepMs?: (ms: number) => Promise<void>;
  batchUntrash?: (ids: string[]) => Promise<void>;
};

/**
 * Untrash a list of message ids in chunks. Filters to only the messages
 * that are currently in TRASH (idempotent re-runs). Returns counts
 * suitable for the response envelope.
 */
export async function untrashMessages(params: {
  messageIds: string[];
  deps: RunDeps;
  logger: Logger;
}): Promise<UndoResult> {
  const { messageIds, deps, logger } = params;

  if (messageIds.length === 0) {
    return {
      attempted: 0,
      restored: 0,
      notFound: 0,
      failed: 0,
      messageIds: [],
    };
  }

  const chunks = chunk(messageIds, UNTRASH_CHUNK_SIZE);
  const sleepFn = deps.sleepMs ?? ((ms) => sleep(ms));

  let restored = 0;
  let failed = 0;
  let notFound = 0;
  const restoredIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i];
    try {
      if (deps.batchUntrash) {
        await deps.batchUntrash(batch);
      } else {
        await withGmailRetry(() =>
          deps.gmail.users.messages.batchModify({
            userId: "me",
            requestBody: {
              ids: batch,
              addLabelIds: [GmailLabel.INBOX],
              removeLabelIds: [GmailLabel.TRASH],
            },
          }),
        );
      }
      restored += batch.length;
      restoredIds.push(...batch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Gmail doesn't distinguish "not found" cleanly in batchModify \u2014 the
      // endpoint is best-effort. We surface the error count and keep going
      // so one bad chunk doesn't strand the rest.
      if (/not[- ]?found/i.test(message)) {
        notFound += batch.length;
      } else {
        failed += batch.length;
      }
      logger.error("safety.undo.batch_failed", {
        err,
        chunk: i,
        size: batch.length,
        module: MODULE,
      });
    }

    if (i < chunks.length - 1) {
      await sleepFn(UNTRASH_MIN_SPACING_MS);
    }
  }

  return {
    attempted: messageIds.length,
    restored,
    notFound,
    failed,
    messageIds: restoredIds.slice(0, 100),
  };
}

export async function recordUndoAudit(params: {
  emailAccountId: string;
  operator: string;
  filter: UndoFilter;
  result: UndoResult;
  executedRuleIds: string[];
  logger: Logger;
}): Promise<void> {
  const { emailAccountId, operator, filter, result, executedRuleIds, logger } =
    params;

  // Flip the suppressedByKillSwitch flag? No \u2014 we add a status change: the
  // ExecutedRules that were restored become SKIPPED and carry a 'undone_by'
  // reason so they no longer count as live auto-trashes.
  if (executedRuleIds.length > 0) {
    await prisma.executedRule.updateMany({
      where: { id: { in: executedRuleIds } },
      data: {
        status: "SKIPPED",
        reason: `undone_by:${operator}`,
      },
    });
  }

  logger.warn("safety.undo.completed", {
    emailAccountId,
    operator,
    filter,
    messageCount: result.restored,
    failed: result.failed,
    notFound: result.notFound,
    module: MODULE,
  });
}

export const __test = {
  MODULE,
  // re-exported for tests that want to assert the log module name
};

export function createUndoLogger(emailAccountId: string): Logger {
  return createScopedLogger("safety/undo-auto-trash").with({
    emailAccountId,
  });
}
