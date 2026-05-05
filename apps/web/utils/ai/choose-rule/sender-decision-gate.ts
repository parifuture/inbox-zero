import type { ParsedMessage } from "@/utils/types";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { SenderAction } from "@/generated/prisma/enums";
import type { SenderDecision } from "@/generated/prisma/client";
import { extractEmailAddress } from "@/utils/email";
import { canonicalizeSender } from "@/utils/sender-decision";
import {
  runGmailOp,
  GmailPipelineError,
  GmailErrorKind,
} from "@/utils/gmail/errors";
import { changeSenderDecision } from "@/utils/sender-decision/change";

const MODULE = "sender-decision.gate";

export type SenderGateSkip = { gated: false };
export type SenderGateApplied = {
  gated: true;
  action: SenderAction; // never "review"
  decision: SenderDecision;
  executedRuleId: string;
};
export type SenderGateResult = SenderGateSkip | SenderGateApplied;

/**
 * Short-circuit the rules engine for a single incoming message.
 *
 * Behavior:
 *  - `auto_trash`   → trash the thread via `provider.trashThread`. Gmail Trash
 *                     only; 30-day recovery. Never permanent delete.
 *  - `auto_archive` → `provider.archiveMessage(messageId)`.
 *  - `always_keep`  → no-op on the provider, but we still record an
 *                     `ExecutedRule` so the audit trail shows the gate fired.
 *  - `review` or no decision → returns `{ gated: false }` and the caller
 *                     falls through to the normal rules + LLM path.
 *
 * Also updates `SenderDecision` volume telemetry (`lastSeenAt`,
 * `messageCount++`, and for applied actions `autoAppliedAt = now()`).
 */
export async function applySenderDecisionGate(params: {
  emailAccountId: string;
  message: ParsedMessage;
  provider: EmailProvider;
  logger: Logger;
  isTest?: boolean;
}): Promise<SenderGateResult> {
  const { emailAccountId, message, provider, logger, isTest } = params;

  // Safety invariant (EL-356 amendment): starred messages are NEVER touched
  // by the autonomous pipeline, regardless of what the SenderDecision says.
  // Starred = user-bookmarked, so a blanket auto_trash/auto_archive on the
  // sender must still let the starred message through to normal evaluation.
  // Matches the EL-357 backlog applier's `-is:starred` safety filter so the
  // live-gate and backlog paths agree on what they'll touch.
  if (message.labelIds?.includes("STARRED")) {
    logger.info("sender_decision.gate.starred_skip", {
      messageId: message.id,
      threadId: message.threadId,
      module: MODULE,
    });
    return { gated: false };
  }

  const fromHeader =
    message.headers?.from ?? extractEmailAddress(message.headers?.from ?? "");
  const canonical = canonicalizeSender(fromHeader);
  if (!canonical) return { gated: false };

  const decision = await prisma.senderDecision.findUnique({
    where: {
      emailAccountId_senderEmail: { emailAccountId, senderEmail: canonical },
    },
  });

  if (!decision || decision.action === "review") {
    return { gated: false };
  }

  const now = new Date();

  // Perform the provider-side action BEFORE recording ExecutedRule so a
  // provider failure doesn't leave a misleading APPLIED row behind.
  //
  // Routed through `runGmailOp` (EL-377) so failures get structured
  // classification, retries on transient errors, and NOT_FOUND downgrades
  // on trash (message already gone — still safe because Gmail Trash only).
  try {
    if (isTest) {
      // no-op
    } else if (decision.action === "auto_trash") {
      await runGmailOp(
        () => provider.trashThread(message.threadId, "", "automation"),
        {
          op: "trash",
          targetId: message.threadId,
          downgradeNotFound: true,
          notFoundValue: undefined,
          logger,
        },
      );
    } else if (decision.action === "auto_archive") {
      await runGmailOp(() => provider.archiveMessage(message.id), {
        op: "archive",
        targetId: message.id,
        downgradeNotFound: true,
        notFoundValue: undefined,
        logger,
      });
    } else if (decision.action === "always_keep" && decision.keepLabelId) {
      // EL-384: apply user-chosen Gmail label to kept messages so Gmail
      // filters / visual cues still fire even though we short-circuit the
      // rules engine. If the label was deleted in Gmail since the decision
      // was saved, clear it on the decision and continue — do NOT fail the
      // keep path.
      try {
        await runGmailOp(
          () =>
            provider.labelMessage({
              messageId: message.id,
              labelId: decision.keepLabelId as string,
              labelName: decision.keepLabelName ?? null,
            }),
          {
            op: "modify_labels",
            targetId: message.id,
            downgradeNotFound: false,
            logger,
          },
        );
      } catch (labelErr) {
        const pipelineErr =
          labelErr instanceof GmailPipelineError ? labelErr : undefined;
        if (pipelineErr?.kind === GmailErrorKind.NOT_FOUND) {
          logger.warn("sender_decision.gate.keep_label.invalid", {
            err: labelErr,
            senderEmail: canonical,
            decisionId: decision.id,
            keepLabelId: decision.keepLabelId,
            keepLabelName: decision.keepLabelName,
            messageId: message.id,
            module: MODULE,
          });
          try {
            await changeSenderDecision({
              emailAccountId,
              senderEmail: canonical,
              action: decision.action,
              decisionSource: decision.source,
              auditSource: "sender-decision-gate:keep-label-invalid",
              actor: "system",
              allowOverwriteUser: true,
              keepLabelId: null,
              keepLabelName: null,
              reason: "keep_label.invalid: Gmail label not found",
            });
          } catch (clearErr) {
            logger.warn("sender_decision.gate.keep_label.clear_failed", {
              err: clearErr,
              decisionId: decision.id,
              module: MODULE,
            });
          }
        } else {
          // Non-404 label failure: log but don't fail the keep path — the
          // message is still successfully kept.
          logger.warn("sender_decision.gate.keep_label_failed", {
            err: labelErr,
            kind: pipelineErr?.kind,
            senderEmail: canonical,
            decisionId: decision.id,
            messageId: message.id,
            module: MODULE,
          });
        }
      }
    }
    // always_keep without keepLabelId: intentionally no provider call.
  } catch (err) {
    const pipelineErr = err instanceof GmailPipelineError ? err : undefined;
    logger.error("sender_decision.gate.provider_failed", {
      err,
      kind: pipelineErr?.kind,
      retryable: pipelineErr?.retryable,
      senderEmail: canonical,
      action: decision.action,
      messageId: message.id,
      threadId: message.threadId,
      module: MODULE,
    });
    // Fall through — don't pretend the action was applied.
    return { gated: false };
  }

  const executedRule = await prisma.executedRule.create({
    data: {
      emailAccountId,
      threadId: message.threadId,
      messageId: message.id,
      status: "APPLIED",
      automated: true,
      reason: `sender_decision:${decision.action}`,
      matchMetadata: {
        gate: "sender_decision",
        decisionId: decision.id,
        senderEmail: canonical,
        action: decision.action,
      },
    },
    select: { id: true },
  });

  // Fire-and-forget: update volume telemetry. Best-effort; non-fatal.
  // @allow-direct-senderdecision-write: telemetry only (lastSeenAt/messageCount/autoAppliedAt) — no action/source/note change, so the audit log doesn't need a row.
  prisma.senderDecision
    .update({
      where: { id: decision.id },
      data: {
        lastSeenAt: now,
        messageCount: { increment: 1 },
        autoAppliedAt: decision.action === "always_keep" ? undefined : now,
      },
    })
    .catch((err) => {
      logger.warn("sender_decision.gate.telemetry_update_failed", {
        err,
        decisionId: decision.id,
        module: MODULE,
      });
    });

  logger.info("sender_decision.applied", {
    senderEmail: canonical,
    action: decision.action,
    decisionId: decision.id,
    messageId: message.id,
    threadId: message.threadId,
    module: MODULE,
  });

  return {
    gated: true,
    action: decision.action,
    decision,
    executedRuleId: executedRule.id,
  };
}
