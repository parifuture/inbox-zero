import type { gmail_v1 } from "@googleapis/gmail";
import type { SenderAction } from "@/generated/prisma/enums";
import type { SenderDecisionJob } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import { GmailLabel } from "@/utils/gmail/label";
import { withGmailRetry } from "@/utils/gmail/retry";
import { runGmailOp } from "@/utils/gmail/errors";
import { getGmailClientForEmail } from "@/utils/email-account-client";
import { createScopedLogger, type Logger } from "@/utils/logger";
import { sleep } from "@/utils/sleep";
import { canonicalizeSenderOrThrow } from "@/utils/sender-decision";

const MODULE = "sender-decision.backlog-applier";

/**
 * Gmail `messages.batchModify` accepts at most 1000 ids per request.
 * We chunk below the limit to leave headroom.
 */
export const BATCH_MODIFY_CHUNK_SIZE = 1000;

/**
 * Minimum spacing between consecutive Gmail mutating calls. Keeps a single
 * job well under the per-user quota (250 quota units / user / second).
 */
export const BATCH_MODIFY_MIN_SPACING_MS = 500;

/** Max pages of messages.list we'll walk before bailing. Defensive only. */
export const LIST_PAGE_SAFETY_CAP = 1000;

export type ApplierAction = Extract<
  SenderAction,
  "auto_trash" | "auto_archive" | "always_keep"
>;

export function isApplierAction(action: SenderAction): action is ApplierAction {
  return (
    action === "auto_trash" ||
    action === "auto_archive" ||
    action === "always_keep"
  );
}

/**
 * Build the Gmail search query and the batchModify label mutation for a
 * given applier action.
 *
 * Safety invariants (Phase 1):
 *  - Never touch `in:sent` (`-in:sent`).
 *  - Never touch starred messages (`-is:starred`).
 *  - Never permanently delete \u2014 trash uses label mutation, which Gmail
 *    recovers for 30 days.
 */
export function buildApplierPlan(
  senderEmail: string,
  action: ApplierAction,
): {
  query: string;
  mutation: { addLabelIds: string[]; removeLabelIds: string[] };
} {
  const base = `from:${senderEmail} -in:sent -is:starred`;

  if (action === "auto_trash") {
    return {
      query: `${base} -in:trash`,
      mutation: {
        addLabelIds: [GmailLabel.TRASH],
        removeLabelIds: [GmailLabel.INBOX],
      },
    };
  }

  if (action === "auto_archive") {
    return {
      query: `${base} in:inbox`,
      mutation: {
        addLabelIds: [],
        removeLabelIds: [GmailLabel.INBOX],
      },
    };
  }

  // always_keep: restore anything previously trashed by an earlier decision.
  return {
    query: `${base} in:trash`,
    mutation: {
      addLabelIds: [GmailLabel.INBOX],
      removeLabelIds: [GmailLabel.TRASH],
    },
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function listAllMessageIds(
  gmail: gmail_v1.Gmail,
  query: string,
  logger: Logger,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let page = 0;

  do {
    if (page >= LIST_PAGE_SAFETY_CAP) {
      logger.warn("sender_decision.backlog.list_cap_hit", {
        query,
        page,
        module: MODULE,
      });
      break;
    }

    const resp = await runGmailOp(
      () =>
        withGmailRetry(() =>
          gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: 500,
            pageToken,
          }),
        ),
      { op: "list", targetId: query, logger },
    );

    for (const m of resp.data.messages ?? []) {
      if (m.id) ids.push(m.id);
    }
    pageToken = resp.data.nextPageToken ?? undefined;
    page += 1;
  } while (pageToken);

  return ids;
}

export type RunApplierDeps = {
  gmail: gmail_v1.Gmail;
  now?: () => Date;
  sleepMs?: (ms: number) => Promise<void>;
  /** Override message listing (tests). */
  listMessageIds?: (query: string) => Promise<string[]>;
  /** Override mutate step (tests). */
  batchModify?: (args: {
    ids: string[];
    mutation: { addLabelIds: string[]; removeLabelIds: string[] };
  }) => Promise<void>;
};

export type RunApplierResult = {
  query: string;
  total: number;
  processed: number;
};

/**
 * Side-effect-only runner. Does NOT touch DB. Returns counts so callers
 * can persist progress / completion.
 */
export async function runApplierSideEffects(params: {
  senderEmail: string;
  action: ApplierAction;
  logger: Logger;
  deps: RunApplierDeps;
}): Promise<RunApplierResult> {
  const { senderEmail, action, logger, deps } = params;
  const { query, mutation } = buildApplierPlan(senderEmail, action);

  const ids = deps.listMessageIds
    ? await deps.listMessageIds(query)
    : await listAllMessageIds(deps.gmail, query, logger);

  logger.info("sender_decision.backlog.listed", {
    senderEmail,
    action,
    query,
    total: ids.length,
    module: MODULE,
  });

  if (ids.length === 0) {
    return { query, total: 0, processed: 0 };
  }

  const chunks = chunk(ids, BATCH_MODIFY_CHUNK_SIZE);
  const sleepFn = deps.sleepMs ?? ((ms) => sleep(ms));

  let processed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i];

    try {
      if (deps.batchModify) {
        await deps.batchModify({ ids: batch, mutation });
      } else {
        await runGmailOp(
          () =>
            withGmailRetry(() =>
              deps.gmail.users.messages.batchModify({
                userId: "me",
                requestBody: {
                  ids: batch,
                  addLabelIds: mutation.addLabelIds.length
                    ? mutation.addLabelIds
                    : undefined,
                  removeLabelIds: mutation.removeLabelIds.length
                    ? mutation.removeLabelIds
                    : undefined,
                },
              }),
            ),
          { op: "batch_modify_labels", targetId: `chunk:${i}`, logger },
        );
      }
      processed += batch.length;
    } catch (err) {
      logger.error("sender_decision.backlog.batch_failed", {
        err,
        senderEmail,
        action,
        chunk: i,
        size: batch.length,
        module: MODULE,
      });
      throw err;
    }

    if (i < chunks.length - 1) {
      await sleepFn(BATCH_MODIFY_MIN_SPACING_MS);
    }
  }

  return { query, total: ids.length, processed };
}

/**
 * End-to-end: looks up the job, runs the side effects, streams status
 * updates into `SenderDecisionJob`. Idempotent \u2014 if the job is already
 * `running`/`completed`/`failed` we no-op (another invocation wins).
 */
export async function runBacklogJob(params: {
  jobId: string;
  logger?: Logger;
  deps?: Partial<RunApplierDeps>;
}): Promise<void> {
  const logger =
    params.logger ?? createScopedLogger("sender-decision/backlog-applier");

  const job = await prisma.senderDecisionJob.findUnique({
    where: { id: params.jobId },
  });
  if (!job) {
    logger.warn("sender_decision.backlog.job_missing", {
      jobId: params.jobId,
      module: MODULE,
    });
    return;
  }

  if (job.status !== "pending") {
    logger.info("sender_decision.backlog.job_already_started", {
      jobId: job.id,
      status: job.status,
      module: MODULE,
    });
    return;
  }

  // Claim the job. If someone else already claimed it (status changed) bail.
  const claimed = await prisma.senderDecisionJob.updateMany({
    where: { id: job.id, status: "pending" },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  try {
    const gmail =
      params.deps?.gmail ??
      (await getGmailClientForEmail({
        emailAccountId: job.emailAccountId,
        logger,
      }));

    const result = await runApplierSideEffects({
      senderEmail: canonicalizeSenderOrThrow(job.senderEmail),
      action: job.action as ApplierAction,
      logger,
      deps: { ...(params.deps ?? {}), gmail },
    });

    await prisma.$transaction([
      prisma.senderDecisionJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          total: result.total,
          progress: result.processed,
          completedAt: new Date(),
        },
      }),
      prisma.senderDecision.updateMany({
        where: {
          emailAccountId: job.emailAccountId,
          senderEmail: job.senderEmail,
        },
        data: { autoAppliedAt: new Date() },
      }),
    ]);

    logger.info("sender_decision.backlog.completed", {
      jobId: job.id,
      total: result.total,
      processed: result.processed,
      module: MODULE,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.senderDecisionJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        error: message.slice(0, 500),
        completedAt: new Date(),
      },
    });
    logger.error("sender_decision.backlog.failed", {
      err,
      jobId: job.id,
      module: MODULE,
    });
  }
}

/**
 * Start a background run of `runBacklogJob` without awaiting.
 * Fire-and-forget: errors are captured inside the runner and persisted
 * onto the job row so the UI can surface them.
 */
export function scheduleBacklogJob(jobId: string, logger?: Logger): void {
  setImmediate(() => {
    runBacklogJob({ jobId, logger }).catch((err) => {
      (logger ?? createScopedLogger("sender-decision/backlog-applier")).error(
        "sender_decision.backlog.scheduler_unhandled",
        { err, jobId, module: MODULE },
      );
    });
  });
}

export type BacklogJobSummary = Pick<
  SenderDecisionJob,
  | "id"
  | "senderEmail"
  | "action"
  | "status"
  | "progress"
  | "total"
  | "error"
  | "startedAt"
  | "completedAt"
  | "createdAt"
>;

export function toJobSummary(job: SenderDecisionJob): BacklogJobSummary {
  return {
    id: job.id,
    senderEmail: job.senderEmail,
    action: job.action,
    status: job.status,
    progress: job.progress,
    total: job.total,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
  };
}
