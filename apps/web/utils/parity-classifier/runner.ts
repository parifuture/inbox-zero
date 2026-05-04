/**
 * EL-358b \u2014 shadow parity pipeline runner.
 *
 * Orchestrates stages 0-4 for a single inbound message using the pure
 * primitives from `stages.ts`, `domains.ts`, `scorer.ts`, `policy.ts`, plus
 * the fork-side helpers in `bedrock.ts` and `sender-aggregate.ts`.
 *
 * SHADOW MODE INVARIANT: this runner NEVER mutates Gmail and NEVER writes
 * to `SenderDecision`, `ExecutedRule`, or any user-facing label state. The
 * only write is the `ParityDecision` observability row (or nothing, if the
 * feature flag is off). The sidecar remains the source of truth for
 * autonomous action until EL-363 verifies agreement.
 */

import { after } from "next/server";
import prisma from "@/utils/prisma";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import { extractEmailAddress, extractDomainFromEmail } from "@/utils/email";
import { internalDateToDate } from "@/utils/date";
import { isAutonomousPaused } from "@/utils/kill-switch";
import type { ParsedMessage } from "@/utils/types";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { emailToContentForAI } from "@/utils/ai/content-sanitizer";
import { SenderAction } from "@/generated/prisma/enums";
import { checkStage0Protected, checkStage1BulkMail } from "./stages";
import { CATEGORY_RULE_NAMES, lookupDomainCategory } from "./domains";
import { computeScore, INBOX_THRESHOLD, REVIEW_THRESHOLD } from "./scorer";
import { applyPolicy } from "./policy";
import { classifyEmailForParity } from "./bedrock";
import { buildSenderAggregate } from "./sender-aggregate";
import type {
  GmailHeaders,
  ParityAction,
  ParityStage,
  PipelineResult,
} from "./types";

const MODULE = "parity-classifier/runner";

export type ParityRunnerEmailAccount = Pick<
  EmailAccountWithAI,
  "id" | "email" | "userId" | "user"
>;

/**
 * Project a `ParsedMessage` into the minimal `GmailHeaders` the classifier
 * expects. ParsedMessage only surfaces a subset of Gmail's raw header bag \u2014
 * we map what's available and leave the rest undefined. That matches the
 * sidecar's `gmailFetchFailed` fallback path, which falls through to the
 * `listUnsubscribeInPrompt` signal.
 */
function projectHeaders(message: ParsedMessage): GmailHeaders {
  return {
    messageId: message.id,
    gmailMessageId: message.headers["message-id"],
    inReplyTo: message.headers["in-reply-to"],
    listUnsubscribe: message.headers["list-unsubscribe"],
    // list-id / list-unsubscribe-post / auto-submitted are not surfaced on
    // ParsedMessageHeaders today; the stage-2 check falls back to the
    // `listUnsubscribeInPrompt` signal when those are missing.
  };
}

async function isDirectReplyFromSender(
  emailAccountId: string,
  inReplyTo: string | undefined,
): Promise<boolean> {
  if (!inReplyTo) return false;
  const normalized = inReplyTo.replace(/[<>]/g, "").trim();
  if (!normalized) return false;
  const hit = await prisma.emailMessage.findFirst({
    where: { emailAccountId, messageId: normalized, sent: true },
    select: { id: true },
  });
  return hit != null;
}

/**
 * Treat `always_keep` as a VIP sender and `auto_trash` as a blocklist-ish
 * marker. The shadow runner still emits a ParityDecision for transparency;
 * the sender-decision gate (EL-356) is what actually short-circuits the
 * live executor.
 */
async function lookupSenderDecision(
  emailAccountId: string,
  senderEmail: string,
): Promise<SenderAction | null> {
  const row = await prisma.senderDecision.findUnique({
    where: {
      emailAccountId_senderEmail: { emailAccountId, senderEmail },
    },
    select: { action: true },
  });
  return row?.action ?? null;
}

function pipelineResult(
  stage: ParityStage,
  action: ParityAction,
  ruleName: string | null,
  reasoning: string,
  extra?: Partial<PipelineResult>,
): PipelineResult {
  return {
    stage,
    action,
    ruleName,
    reasoning,
    bedrockUsed: false,
    gmailFetchFailed: false,
    ...extra,
  };
}

export type RunParityOptions = {
  emailAccount: ParityRunnerEmailAccount;
  message: ParsedMessage;
  /** Override the current date for deterministic tests. */
  now?: Date;
  /** Allow tests to inject a stub aggregate without touching Prisma. */
  buildAggregate?: typeof buildSenderAggregate;
  /** Allow tests to inject a stub classifier without calling Bedrock. */
  classify?: typeof classifyEmailForParity;
  /** Override kill-switch lookup (defaults to the real one). */
  killSwitch?: (emailAccountId: string) => Promise<boolean>;
};

/**
 * Run the full classifier pipeline for a single inbound message. Pure in
 * spirit (no Gmail mutations, no user-state writes); the only side effects
 * are Postgres reads of `EmailMessage`/`ResponseTime`/`SenderDecision`.
 *
 * Callers persist the return value via `persistParityDecision` when
 * `PARITY_SHADOW_ENABLED` is on.
 */
export async function runParityPipeline(
  opts: RunParityOptions,
): Promise<PipelineResult> {
  const {
    emailAccount,
    message,
    now = new Date(),
    buildAggregate = buildSenderAggregate,
    classify = classifyEmailForParity,
    killSwitch = isAutonomousPaused,
  } = opts;

  const senderEmail = extractEmailAddress(message.headers.from).toLowerCase();
  const senderDomain = extractDomainFromEmail(
    message.headers.from,
  ).toLowerCase();
  const subject = message.headers.subject ?? "";
  const headers = projectHeaders(message);
  const listUnsubscribeInPrompt = Boolean(message.headers["list-unsubscribe"]);

  // Kill-switch pre-check. We still run stages 0-3 (cheap) but short-circuit
  // before hitting Bedrock when the account is paused \u2014 paying for LLM calls
  // while autonomous actions are disabled is the worst of both worlds.
  const paused = await killSwitch(emailAccount.id).catch(() => false);

  // Sender decision (treated as blocklist / VIP hints).
  const senderAction = await lookupSenderDecision(
    emailAccount.id,
    senderEmail,
  ).catch(() => null);

  if (senderAction === SenderAction.auto_trash) {
    return pipelineResult(
      0,
      "trash",
      null,
      `Sender marked auto_trash: ${senderEmail}`,
      { headers },
    );
  }

  // Stage 0 \u2014 protected classes.
  const isVipSender = senderAction === SenderAction.always_keep;
  const isDirectReply = await isDirectReplyFromSender(
    emailAccount.id,
    headers.inReplyTo,
  ).catch(() => false);

  const primaryDomain = env.PARITY_PRIMARY_DOMAIN?.toLowerCase() ?? null;

  const s0 = checkStage0Protected(
    senderEmail,
    senderDomain,
    isVipSender,
    isDirectReply,
    subject,
    primaryDomain,
  );
  if (s0) {
    return pipelineResult(0, s0.action, null, s0.reasoning, { headers });
  }

  // Stage 1 \u2014 deterministic domain routing.
  const domainCategory = lookupDomainCategory(senderEmail, senderDomain);
  if (domainCategory) {
    const ruleName = CATEGORY_RULE_NAMES[domainCategory];
    const isLegal =
      domainCategory === "legal-vauld" ||
      domainCategory === "legal-celsius" ||
      domainCategory === "legal-solar";
    if (domainCategory === "marketing") {
      // Shadow-only: record intent, do NOT actually trash here.
      return pipelineResult(
        1,
        "trash",
        null,
        `Marketing domain: ${senderDomain} \u2014 would trash (shadow, no mutation)`,
        { headers },
      );
    }
    return pipelineResult(
      1,
      isLegal ? "inbox" : "review",
      isLegal ? null : ruleName,
      `Known domain: ${senderDomain} \u2192 ${domainCategory}`,
      { headers },
    );
  }

  // Stage 2 \u2014 bulk-mail signals.
  const s2 = checkStage1BulkMail(headers, listUnsubscribeInPrompt);
  if (s2) {
    return pipelineResult(2, s2.action, "Newsletter", s2.reasoning, {
      headers,
    });
  }

  // Stage 3 \u2014 personal-priority scorer.
  const aggregate = await buildAggregate(emailAccount.id, senderEmail).catch(
    () => null,
  );
  const scoreResult = computeScore(aggregate, now, senderEmail);

  if (scoreResult.score >= INBOX_THRESHOLD) {
    return pipelineResult(
      3,
      "inbox",
      null,
      `Scorer: ${scoreResult.score.toFixed(3)} >= ${INBOX_THRESHOLD} (replies=${scoreResult.replyCount}, source=${scoreResult.source})`,
      { headers },
    );
  }
  if (scoreResult.score <= REVIEW_THRESHOLD) {
    return pipelineResult(
      3,
      "review",
      "Review",
      `Scorer: ${scoreResult.score.toFixed(3)} <= ${REVIEW_THRESHOLD} (source=${scoreResult.source})`,
      { headers },
    );
  }

  // Stage 4 \u2014 Bedrock content classification.
  if (paused || !env.PARITY_SHADOW_BEDROCK_ENABLED) {
    const reason = paused
      ? "skipped_by_kill_switch"
      : "stage4_disabled_by_flag";
    return pipelineResult(
      4,
      "review",
      "Review",
      `Stage 4 skipped (${reason}) \u2014 fallback to Review`,
      { headers },
    );
  }

  const content = emailToContentForAI(message, {
    maxLength: 4000,
    extractReply: true,
    removeForwarded: true,
  });
  const classification = await classify(
    emailAccount,
    {
      from: message.headers.from,
      subject,
      content,
      date: internalDateToDate(message.internalDate),
      listUnsubscribe: message.headers["list-unsubscribe"],
    },
    scoreResult.score,
  );

  if (!classification) {
    return pipelineResult(
      4,
      "review",
      "Review",
      "Stage 4 classification failed \u2014 routing to Review as safe fallback",
      { headers, bedrockUsed: false },
    );
  }

  const policy = applyPolicy(classification, scoreResult.score);
  return pipelineResult(
    4,
    policy.noMatchFound ? "inbox" : "review",
    policy.ruleName,
    `[${classification.category}] confidence=${classification.confidence.toFixed(2)} label=${classification.label ?? "null"} | ${classification.reasoning}`,
    {
      headers,
      bedrockUsed: true,
      category: classification.category,
      labelAssigned: classification.label,
    },
  );
}

/**
 * Persist a `PipelineResult` as a `ParityDecision` row. Idempotent on
 * `(emailAccountId, messageId)` \u2014 a retried webhook won't create
 * duplicates.
 */
export async function persistParityDecision(params: {
  emailAccountId: string;
  message: ParsedMessage;
  result: PipelineResult;
  durationMs: number;
  score: number | null;
  confidence: number | null;
}): Promise<void> {
  const { emailAccountId, message, result, durationMs, score, confidence } =
    params;

  const senderEmail = extractEmailAddress(message.headers.from).toLowerCase();
  const senderDomain = extractDomainFromEmail(
    message.headers.from,
  ).toLowerCase();

  try {
    await prisma.parityDecision.upsert({
      where: {
        emailAccountId_messageId: { emailAccountId, messageId: message.id },
      },
      create: {
        emailAccountId,
        messageId: message.id,
        threadId: message.threadId,
        senderEmail,
        senderDomain,
        subject: message.headers.subject ?? null,
        stage: result.stage,
        action: result.action,
        ruleName: result.ruleName,
        category: result.category ?? null,
        labelAssigned: result.labelAssigned ?? null,
        score,
        confidence,
        reasoning: result.reasoning,
        bedrockUsed: result.bedrockUsed,
        gmailFetchFailed: result.gmailFetchFailed,
        durationMs,
      },
      update: {
        // On replay, refresh the signal fields but preserve sidecar*
        // columns (those are populated by EL-363 harness, not this runner).
        stage: result.stage,
        action: result.action,
        ruleName: result.ruleName,
        category: result.category ?? null,
        labelAssigned: result.labelAssigned ?? null,
        score,
        confidence,
        reasoning: result.reasoning,
        bedrockUsed: result.bedrockUsed,
        gmailFetchFailed: result.gmailFetchFailed,
        durationMs,
      },
    });
  } catch (error) {
    createScopedLogger(MODULE).warn("parity.persist.failed", {
      emailAccountId,
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Top-level entry point used by the webhook processor. Gated on
 * `PARITY_SHADOW_ENABLED`. Errors are swallowed with structured logs \u2014 this
 * code path is observability-only and must never take down the real
 * triage pipeline.
 */
export async function runShadowAndPersist(opts: {
  emailAccount: ParityRunnerEmailAccount;
  message: ParsedMessage;
}): Promise<void> {
  if (!env.PARITY_SHADOW_ENABLED) return;

  const logger = createScopedLogger(MODULE);
  const startedAt = Date.now();

  try {
    const result = await runParityPipeline({
      emailAccount: opts.emailAccount,
      message: opts.message,
    });
    const durationMs = Date.now() - startedAt;

    // Best-effort score/confidence extraction for the decision row.
    const score = extractScoreFromReasoning(result.reasoning);
    const confidence = extractConfidenceFromReasoning(result.reasoning);

    await persistParityDecision({
      emailAccountId: opts.emailAccount.id,
      message: opts.message,
      result,
      durationMs,
      score,
      confidence,
    });

    logger.info("parity.decision", {
      emailAccountId: opts.emailAccount.id,
      messageId: opts.message.id,
      stage: result.stage,
      action: result.action,
      ruleName: result.ruleName,
      bedrockUsed: result.bedrockUsed,
      durationMs,
    });
  } catch (error) {
    logger.warn("parity.runner.failed", {
      emailAccountId: opts.emailAccount.id,
      messageId: opts.message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Convenience wrapper for webhook call sites: schedules the shadow run via
 * `after()` so the real pipeline's latency is unaffected. No-op when the
 * feature flag is off.
 */
export function scheduleParityShadow(opts: {
  emailAccount: ParityRunnerEmailAccount;
  message: ParsedMessage;
}): void {
  if (!env.PARITY_SHADOW_ENABLED) return;
  after(() => runShadowAndPersist(opts));
}

// ── Exported for tests / Decisions-tab diagnostics ──────────────────────────

export function extractScoreFromReasoning(reasoning: string): number | null {
  const match = reasoning.match(/Scorer:\s*([0-9.]+)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

export function extractConfidenceFromReasoning(
  reasoning: string,
): number | null {
  const match = reasoning.match(/confidence=([0-9.]+)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}
