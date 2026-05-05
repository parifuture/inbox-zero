import type { gmail_v1 } from "@googleapis/gmail";
import {
  ActionType,
  ClassificationFeedbackEventType,
} from "@/generated/prisma/enums";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { EmailProvider } from "@/utils/email/types";
import { GMAIL_SYSTEM_LABELS } from "@/utils/gmail/label";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { isEligibleForClassificationFeedback } from "@/utils/rule/consts";
import {
  findRuleByLabelId,
  saveClassificationFeedback,
} from "@/utils/rule/classification-feedback";
import { fetchSenderFromMessage } from "@/app/api/google/webhook/fetch-sender-from-message";

/**
 * When labels are added to an email with a system meaning, record it as
 * classification feedback so the sender-decision / learned-pattern pipelines
 * can react. EL-361b: the legacy SPAM → cold-email learning was removed with
 * the rest of the Cold Email Blocker.
 */
export async function handleLabelAddedEvent(
  message: gmail_v1.Schema$HistoryLabelAdded,
  {
    emailAccount,
    provider,
  }: {
    emailAccount: EmailAccountWithAI;
    provider: EmailProvider;
  },
  logger: Logger,
) {
  const messageId = message.message?.id;
  const threadId = message.message?.threadId;
  const emailAccountId = emailAccount.id;
  const addedLabelIds = message.labelIds || [];

  if (!messageId || !threadId) {
    logger.error("Skipping label added - missing messageId or threadId");
    return;
  }

  const classifiableLabelIds = addedLabelIds.filter(
    (labelId) => !GMAIL_SYSTEM_LABELS.includes(labelId),
  );

  if (classifiableLabelIds.length === 0) {
    logger.trace("No actionable labels added, skipping", {
      messageId,
      addedLabelIds,
    });
    return;
  }

  const sender = await fetchSenderFromMessage(messageId, provider, logger);
  if (!sender) return;

  await Promise.all(
    classifiableLabelIds.map((labelId) =>
      recordClassificationFromLabelAdd({
        labelId,
        sender,
        messageId,
        threadId,
        emailAccountId,
        logger,
      }),
    ),
  );
}

async function recordClassificationFromLabelAdd({
  labelId,
  sender,
  messageId,
  threadId,
  emailAccountId,
  logger,
}: {
  labelId: string;
  sender: string;
  messageId: string;
  threadId: string;
  emailAccountId: string;
  logger: Logger;
}) {
  const rule = await findRuleByLabelId({ labelId, emailAccountId });

  if (!rule) return;

  if (!isEligibleForClassificationFeedback(rule.systemType)) return;

  // Self-labeling filter: skip if Inbox Zero already applied this label
  const systemApplied = await wasLabelAppliedBySystem({
    messageId,
    emailAccountId,
    labelId,
  });

  if (systemApplied) {
    logger.trace("Label was applied by system, skipping classification", {
      labelId,
    });
    return;
  }

  await saveClassificationFeedback({
    emailAccountId,
    sender,
    ruleId: rule.id,
    threadId,
    messageId,
    eventType: ClassificationFeedbackEventType.LABEL_ADDED,
    logger,
  });
}

async function wasLabelAppliedBySystem({
  messageId,
  emailAccountId,
  labelId,
}: {
  messageId: string;
  emailAccountId: string;
  labelId: string;
}): Promise<boolean> {
  const executedAction = await prisma.executedAction.findFirst({
    where: {
      labelId,
      type: ActionType.LABEL,
      executedRule: {
        messageId,
        emailAccountId,
      },
    },
    select: { id: true },
  });

  return !!executedAction;
}
