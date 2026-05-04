import type { ParsedMessage } from "@/utils/types";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { SenderAction } from "@/generated/prisma/enums";
import type { SenderDecision } from "@/generated/prisma/client";
import { extractEmailAddress } from "@/utils/email";
import { canonicalizeSender } from "@/utils/sender-decision";

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
  try {
    if (isTest) {
      // no-op
    } else if (decision.action === "auto_trash") {
      await provider.trashThread(message.threadId, "", "automation");
    } else if (decision.action === "auto_archive") {
      await provider.archiveMessage(message.id);
    }
    // always_keep: intentionally no provider call.
  } catch (err) {
    logger.error("sender_decision.gate.provider_failed", {
      err,
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
