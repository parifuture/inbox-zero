import type { SenderAction } from "@/generated/prisma/enums";
import type { SenderDecision } from "@/generated/prisma/client";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import {
  canonicalizeSenderOrThrow,
  upsertDecision,
} from "@/utils/sender-decision";
import { logDecisionAudit } from "@/utils/sender-decision/audit";

const logger = createScopedLogger("sender-decision");

/**
 * EL-365: the one-and-only path through which a SenderDecision is mutated.
 *
 * Every API route, background job, rule engine, or CLI that changes a
 * decision must call this helper. Direct `prisma.senderDecision.update /
 * upsert / create / delete` is gated by a Biome rule
 * (`noRestrictedSyntax`) so regressions are caught at lint time.
 *
 * Responsibilities:
 *   1. Canonicalize the sender email.
 *   2. Snapshot `before` state.
 *   3. Delegate to `upsertDecision` (which respects user-stickiness).
 *   4. Write a `SenderDecisionAudit` row with `source` + `reason`.
 *   5. Emit a structured log so tailing stdout / downstream log sinks can
 *      pick up every sender-decision change without DB access.
 */

export type ChangeSenderDecisionKind = "create" | "update" | "delete" | "bulk";

export interface ChangeSenderDecisionInput {
  action: SenderAction;
  /** Who performed the change — default "user". */
  actor?: "user" | "system" | "seed" | (string & {});
  /** When set, skip the user-stickiness guard (e.g. user overriding themselves). */
  allowOverwriteUser?: boolean;
  /**
   * Surface that produced the change — audit column. Distinct from
   * `decisionSource`: multiple surfaces can write with source="user".
   *
   * Examples: "ui:decisions", "ui:historical-cleanup", "api:import",
   * "api:bulk", "api:onboarding", "parity-runner", "backlog-applier".
   */
  auditSource: string;
  autoAppliedAt?: Date | null;
  /** Upstream source system — e.g. "user", "seed", "llm_suggestion", "rule". */
  decisionSource: string;
  emailAccountId: string;
  /** Extra upsert metadata — passed through to `upsertDecision`. */
  firstSeenAt?: Date | null;
  keepLabelId?: string | null;
  keepLabelName?: string | null;
  /** Optional kind hint. Derived automatically if omitted. */
  kind?: ChangeSenderDecisionKind;
  lastSeenAt?: Date | null;
  messageCount?: number;
  /** Optional note persisted on the row. */
  note?: string | null;
  /** Free-text reason shown in the history UI and log stream. */
  reason?: string | null;
  senderEmail: string;
}

export interface ChangeSenderDecisionResult {
  after: SenderDecision;
  before: SenderDecision | null;
  kind: ChangeSenderDecisionKind;
}

export async function changeSenderDecision(
  input: ChangeSenderDecisionInput,
): Promise<ChangeSenderDecisionResult> {
  const senderEmail = canonicalizeSenderOrThrow(input.senderEmail);
  const actor = input.actor ?? "user";

  const before = await prisma.senderDecision.findUnique({
    where: {
      emailAccountId_senderEmail: {
        emailAccountId: input.emailAccountId,
        senderEmail,
      },
    },
  });

  const after = await upsertDecision({
    emailAccountId: input.emailAccountId,
    senderEmail,
    action: input.action,
    source: input.decisionSource,
    note: input.note ?? null,
    firstSeenAt: input.firstSeenAt ?? null,
    lastSeenAt: input.lastSeenAt ?? null,
    messageCount: input.messageCount,
    autoAppliedAt: input.autoAppliedAt ?? null,
    keepLabelId: input.keepLabelId,
    keepLabelName: input.keepLabelName,
    protectUserDecisions: !input.allowOverwriteUser,
  });

  const kind: ChangeSenderDecisionKind =
    input.kind ?? (before ? "update" : "create");

  await logDecisionAudit({
    emailAccountId: input.emailAccountId,
    senderEmail,
    before,
    after,
    actor,
    action: kind,
    source: input.auditSource,
    reason: input.reason ?? null,
  });

  logger.info("sender_decision.changed", {
    emailAccountId: input.emailAccountId,
    senderEmail,
    kind,
    actor,
    auditSource: input.auditSource,
    decisionSource: input.decisionSource,
    before: before?.action ?? null,
    after: after.action,
    reason: input.reason ?? null,
  });

  return { before, after, kind };
}

/**
 * Soft-delete path. We never hard-delete `SenderDecision` rows (volume
 * telemetry + audit integrity), so "delete" resets the row to action=review
 * + source=user. Emits a `sender_decision.deleted` structured log on top of
 * the regular `sender_decision.changed` line so log-based monitoring can
 * alert on destructive actions specifically.
 */
export async function deleteSenderDecision(
  input: Omit<ChangeSenderDecisionInput, "action" | "kind"> & {
    action?: never;
    kind?: never;
  },
): Promise<ChangeSenderDecisionResult> {
  const result = await changeSenderDecision({
    ...input,
    action: "review",
    kind: "delete",
    allowOverwriteUser: true,
  });

  logger.info("sender_decision.deleted", {
    emailAccountId: input.emailAccountId,
    senderEmail: result.after.senderEmail,
    actor: input.actor ?? "user",
    auditSource: input.auditSource,
    reason: input.reason ?? null,
    previousAction: result.before?.action ?? null,
  });

  return result;
}
