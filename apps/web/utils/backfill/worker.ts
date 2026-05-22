/**
 * EL-473 — Backfill worker + Gmail executor.
 *
 * Two entrypoints, gated by Run.status:
 *
 *  evaluateRun(runId)
 *    Walks the sender shortlist for the run, asks the LLM evaluator
 *    for one chunk-at-a-time dispositions, writes BackfillDecision
 *    rows. Updates Run counters as it goes. Transitions to
 *    `awaiting_execution` (dryRun) or `executing` (auto-execute)
 *    when complete.
 *
 *  executeRun(runId)
 *    SELECTs decisions WHERE executedAt IS NULL and applies them via
 *    the EmailProvider. ARCHIVE / MARK_READ / LABEL are batched by
 *    threadId. TRASH uses trashThread per id (EL-459 invariant —
 *    batchModify+TRASH does not work; we always go through the
 *    provider's trashThread method which uses users.messages.trash).
 *
 * Both are idempotent and resumable: re-running picks up where it
 * left off via row state.
 */

import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { createEmailProvider } from "@/utils/email/provider";
import {
  MirrorReader,
  defaultMirrorPath,
  type SenderShortlistRow,
} from "@/utils/backfill/mirror";
import {
  evaluateSenderChunk,
  MAX_EMAILS_PER_EVALUATION,
  type EvaluatorDecision,
} from "@/utils/backfill/evaluator";
import { getEmailAccountWithAi } from "@/utils/user/get";
import type { BackfillRun, BackfillDecision } from "@/generated/prisma/client";

const logger = createScopedLogger("backfill-worker");

const TRUNCATE_REASON_AT = 500;

/**
 * Adapter shape so tests can drive the worker without touching the real
 * Bedrock / Gmail / Postgres layers. Each field has a sensible default
 * built from the runtime modules; overrides are for tests.
 */
export interface WorkerDeps {
  buildProvider?: typeof createEmailProvider;
  evaluate?: typeof evaluateSenderChunk;
  loadEmailAccount?: typeof getEmailAccountWithAi;
  mirrorPath?: string;
}

// ────────────────────────────────────────────────────────────────────
// Phase A — evaluator (mirror-driven, LLM-fed, decision-writing)
// ────────────────────────────────────────────────────────────────────

export async function evaluateRun(
  runId: string,
  deps: WorkerDeps = {},
): Promise<void> {
  const evaluate = deps.evaluate ?? evaluateSenderChunk;
  const loadEmailAccount = deps.loadEmailAccount ?? getEmailAccountWithAi;
  const mirrorPath = deps.mirrorPath ?? defaultMirrorPath();

  const run = await prisma.backfillRun.findUniqueOrThrow({
    where: { id: runId },
  });
  if (run.status !== "pending" && run.status !== "evaluating") {
    logger.warn("evaluateRun: run is not in an evaluable state", {
      runId,
      status: run.status,
    });
    return;
  }

  const emailAccount = await loadEmailAccount({
    emailAccountId: run.emailAccountId,
  });
  if (!emailAccount) {
    await markError(runId, "EmailAccount not found");
    return;
  }

  const rules = await prisma.rule.findMany({
    where: {
      id: { in: run.ruleIds },
      emailAccountId: run.emailAccountId,
    },
    include: { actions: true, group: true },
  });
  if (rules.length === 0) {
    await markError(runId, "No selected rules found");
    return;
  }

  const reader = new MirrorReader(mirrorPath);
  try {
    const senders = reader.listSenders({
      dateFloor: run.dateFloor ?? undefined,
      senderScope: run.senderScope ?? undefined,
    });

    await prisma.backfillRun.update({
      where: { id: runId },
      data: {
        status: "evaluating",
        totalSenders: senders.length,
        startedAt: run.startedAt ?? new Date(),
      },
    });

    let processed = 0;
    let decided = 0;

    for (const sender of senders) {
      // Cooperative cancellation — re-read run.status before starting
      // each sender so a UI 'Stop' click can interrupt the loop.
      const fresh = await prisma.backfillRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (fresh?.status === "stopped") {
        logger.info("evaluateRun: stopped by user", { runId });
        return;
      }

      await prisma.backfillRun.update({
        where: { id: runId },
        data: { currentSender: sender.fromAddress },
      });

      try {
        decided += await evaluateSenderForRun({
          run,
          reader,
          sender,
          rules,
          emailAccount,
          evaluate,
        });
        processed += 1;
        await prisma.backfillRun.update({
          where: { id: runId },
          data: {
            processedSenders: processed,
            totalDecisions: decided,
          },
        });
      } catch (err) {
        logger.error("evaluateRun: sender failed", {
          runId,
          sender: sender.fromAddress,
          error: err,
        });
        await prisma.backfillRun.update({
          where: { id: runId },
          data: {
            errorCount: { increment: 1 },
            lastError: errString(err),
          },
        });
      }
    }

    // Reached end of sender list — transition.
    const next = run.dryRun ? "awaiting_execution" : "executing";
    await prisma.backfillRun.update({
      where: { id: runId },
      data: {
        status: next,
        currentSender: null,
        evaluatedAt: new Date(),
      },
    });
    logger.info("evaluateRun: finished evaluation phase", {
      runId,
      next,
      decided,
      processed,
    });
  } finally {
    reader.close();
  }
}

async function evaluateSenderForRun(args: {
  run: BackfillRun;
  reader: MirrorReader;
  sender: SenderShortlistRow;
  rules: Awaited<ReturnType<typeof prisma.rule.findMany>>;
  emailAccount: NonNullable<Awaited<ReturnType<typeof getEmailAccountWithAi>>>;
  evaluate: typeof evaluateSenderChunk;
}): Promise<number> {
  const { run, reader, sender, rules, emailAccount, evaluate } = args;
  let decisionsWritten = 0;
  for await (const chunk of reader.loadSenderHistory(sender.fromAddress, {
    dateFloor: run.dateFloor ?? undefined,
    chunkSize: MAX_EMAILS_PER_EVALUATION,
  })) {
    if (chunk.length === 0) continue;
    const decisions = await evaluate({
      emailAccount,
      // The Prisma payload includes `actions` + `group`; the evaluator
      // narrows what it consumes.
      // biome-ignore lint/suspicious/noExplicitAny: cross-payload narrowing
      rules: rules as any,
      sender: sender.fromAddress,
      emails: chunk,
      modelLabel: "Backfill: evaluate sender",
    });
    decisionsWritten += await persistDecisions({
      runId: run.id,
      sender: sender.fromAddress,
      chunk,
      decisions,
    });
  }
  return decisionsWritten;
}

async function persistDecisions(args: {
  runId: string;
  sender: string;
  chunk: { id: string; threadId: string | null }[];
  decisions: EvaluatorDecision[];
}): Promise<number> {
  // Build a messageId → threadId lookup so we can store threadId on
  // the decision row at write time (avoids re-fetching from Gmail at
  // execute time).
  const threadById = new Map(args.chunk.map((c) => [c.id, c.threadId]));

  const rows = args.decisions.map((d) => ({
    runId: args.runId,
    messageId: d.messageId,
    threadId: threadById.get(d.messageId) ?? null,
    sender: args.sender,
    ruleId: d.ruleId ?? null,
    action: d.action,
    labelName: d.labelName ?? null,
    reason: d.reason.slice(0, TRUNCATE_REASON_AT),
    confidence: d.confidence,
  }));

  if (rows.length === 0) return 0;

  // EL-484: skipDuplicates is now load-bearing — BackfillDecision has a
  // @@unique([runId, messageId]) constraint, so a re-run of evaluateRun
  // (e.g. after a process death) silently drops rows it has already
  // written rather than crashing OR ballooning the audit log.
  const result = await prisma.backfillDecision.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return result.count;
}

// ────────────────────────────────────────────────────────────────────
// Phase B — Gmail executor (idempotent, EL-459-safe trash)
// ────────────────────────────────────────────────────────────────────

export interface ExecuteRunOptions {
  /** Process at most this many decisions per call. Default unbounded. */
  limit?: number;
}

export async function executeRun(
  runId: string,
  opts: ExecuteRunOptions = {},
  deps: WorkerDeps = {},
): Promise<void> {
  const buildProvider = deps.buildProvider ?? createEmailProvider;

  const run = await prisma.backfillRun.findUniqueOrThrow({
    where: { id: runId },
  });
  if (run.status !== "awaiting_execution" && run.status !== "executing") {
    logger.warn("executeRun: run is not in an executable state", {
      runId,
      status: run.status,
    });
    return;
  }

  await prisma.backfillRun.update({
    where: { id: runId },
    data: { status: "executing" },
  });

  // Need the provider — go through createEmailProvider so we get the
  // OAuth-refreshed Gmail client. The provider knows the account's
  // own email (used by archive/trash thread methods).
  const account = await prisma.emailAccount.findUniqueOrThrow({
    where: { id: run.emailAccountId },
    select: { id: true, email: true, account: { select: { provider: true } } },
  });
  const provider = await buildProvider({
    emailAccountId: account.id,
    provider: account.account.provider,
    logger,
  });

  let processed = 0;
  for (;;) {
    if (typeof opts.limit === "number" && processed >= opts.limit) break;

    // Cooperative cancellation
    const fresh = await prisma.backfillRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (fresh?.status === "stopped") {
      logger.info("executeRun: stopped by user", { runId });
      return;
    }

    const batch = await prisma.backfillDecision.findMany({
      where: {
        runId,
        executedAt: null,
        executionError: null, // skip ones that already errored — avoids infinite retry
        action: { not: "SKIP" },
      },
      orderBy: { decidedAt: "asc" },
      take: 50,
    });
    if (batch.length === 0) break;

    for (const decision of batch) {
      try {
        await applyDecision(provider, account.email, decision);
        await prisma.backfillDecision.update({
          where: { id: decision.id },
          data: { executedAt: new Date() },
        });
        await prisma.backfillRun.update({
          where: { id: runId },
          data: { executedDecisions: { increment: 1 } },
        });
        processed += 1;
      } catch (err) {
        logger.error("executeRun: decision failed", {
          decisionId: decision.id,
          messageId: decision.messageId,
          action: decision.action,
          error: err,
        });
        await prisma.backfillDecision.update({
          where: { id: decision.id },
          data: { executionError: errString(err) },
        });
        await prisma.backfillRun.update({
          where: { id: runId },
          data: { errorCount: { increment: 1 } },
        });
      }
    }
  }

  // SKIP rows are no-ops at the Gmail layer but we still want them out
  // of the queue so progress counters / done-detection are accurate.
  // Done OUTSIDE the actionable loop so a run consisting only of SKIPs
  // still gets cleaned up.
  await prisma.backfillDecision.updateMany({
    where: { runId, executedAt: null, action: "SKIP" },
    data: { executedAt: new Date() },
  });

  // Are we done?
  // "Done" = no decisions left to attempt. Failed-but-recorded decisions
  // (executionError set, executedAt null) DON'T block done — the user
  // can re-run the executor with the failed ones cleared if they want
  // to retry them.
  const remaining = await prisma.backfillDecision.count({
    where: { runId, executedAt: null, executionError: null },
  });
  if (remaining === 0) {
    await prisma.backfillRun.update({
      where: { id: runId },
      data: {
        status: "done",
        executedAt: new Date(),
        completedAt: new Date(),
      },
    });
  }
  logger.info("executeRun: batch complete", { runId, processed, remaining });
}

async function applyDecision(
  provider: Awaited<ReturnType<typeof createEmailProvider>>,
  ownerEmail: string,
  decision: BackfillDecision,
): Promise<void> {
  switch (decision.action) {
    case "ARCHIVE": {
      // Prefer thread-level archive when we have a threadId; falls
      // back to message-level for orphan messages.
      if (decision.threadId) {
        await provider.archiveThread(decision.threadId, ownerEmail);
      } else {
        await provider.archiveMessage(decision.messageId);
      }
      return;
    }
    case "TRASH": {
      // EL-459 invariant: TRASH must use users.messages.trash semantics.
      // The provider's trashThread method does that correctly.
      if (!decision.threadId) {
        throw new Error(
          `TRASH decision is missing threadId (decisionId=${decision.id} messageId=${decision.messageId})`,
        );
      }
      await provider.trashThread(decision.threadId, ownerEmail, "automation");
      return;
    }
    case "MARK_READ": {
      if (!decision.threadId) {
        throw new Error(
          `MARK_READ decision is missing threadId (decisionId=${decision.id})`,
        );
      }
      await provider.markRead(decision.threadId);
      return;
    }
    case "LABEL": {
      if (!decision.labelName) {
        throw new Error(
          `LABEL decision is missing labelName (decisionId=${decision.id})`,
        );
      }
      await provider.labelMessage({
        messageId: decision.messageId,
        labelId: decision.labelName, // provider resolves label-by-name when labelId looks like a name
        labelName: decision.labelName,
      });
      return;
    }
    case "SKIP":
      return; // no-op; caller marks executedAt separately
    default:
      throw new Error(`Unknown action: ${decision.action}`);
  }
}

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────

async function markError(runId: string, message: string): Promise<void> {
  await prisma.backfillRun.update({
    where: { id: runId },
    data: {
      status: "error",
      lastError: message,
      completedAt: new Date(),
    },
  });
}

function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
