import type { gmail_v1 } from "@googleapis/gmail";
import { ClassificationFeedbackEventType } from "@/generated/prisma/enums";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { EmailProvider } from "@/utils/email/types";
import { GMAIL_SYSTEM_LABELS } from "@/utils/gmail/label";
import type { Logger } from "@/utils/logger";
import { recordLabelRemovalLearning } from "@/utils/rule/record-label-removal-learning";
import { isEligibleForClassificationFeedback } from "@/utils/rule/consts";
import {
  findRuleByLabelId,
  saveClassificationFeedback,
} from "@/utils/rule/classification-feedback";
import { fetchSenderFromMessage } from "@/app/api/google/webhook/fetch-sender-from-message";

export async function handleLabelRemovedEvent(
  message: gmail_v1.Schema$HistoryLabelRemoved,
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
  const allRemovedLabelIds = message.labelIds || [];

  if (!messageId || !threadId) {
    logger.error("Skipping label removal - missing messageId or threadId", {
      hasMessage: !!message.message,
      hasLabelIds: allRemovedLabelIds.length > 0,
      labelIds: allRemovedLabelIds,
    });
    return;
  }

  const removedLabelIds = allRemovedLabelIds.filter(
    (labelId) => !GMAIL_SYSTEM_LABELS.includes(labelId),
  );

  if (removedLabelIds.length === 0) {
    logger.trace("No non-system labels removed, skipping", {
      messageId,
      threadId,
      systemLabelsRemoved: allRemovedLabelIds,
    });
    return;
  }

  logger.info("Processing label removal for learning", {
    labelCount: removedLabelIds.length,
    removedLabels: removedLabelIds,
  });

  const sender = await fetchSenderFromMessage(messageId, provider, logger);
  if (!sender) return;

  for (const labelId of removedLabelIds) {
    try {
      await learnFromRemovedLabel({
        labelId,
        sender,
        messageId,
        threadId,
        emailAccountId,
        logger,
      });
    } catch (error) {
      logger.error("Error learning from label removal", {
        error,
        labelId,
        removedLabelIds,
      });
    }
  }
}

async function learnFromRemovedLabel({
  labelId,
  sender,
  messageId,
  threadId,
  emailAccountId,
  logger,
}: {
  labelId: string;
  sender: string | null;
  messageId: string;
  threadId: string;
  emailAccountId: string;
  logger: Logger;
}) {
  logger = logger.with({ labelId });

  const rule = await findRuleByLabelId({ labelId, emailAccountId });

  await recordLabelRemovalLearning({
    sender,
    ruleId: rule?.id,
    systemType: rule?.systemType,
    messageId,
    threadId,
    emailAccountId,
    logger,
  });

  if (rule && sender && isEligibleForClassificationFeedback(rule.systemType)) {
    await saveClassificationFeedback({
      emailAccountId,
      sender,
      ruleId: rule.id,
      threadId,
      messageId,
      eventType: ClassificationFeedbackEventType.LABEL_REMOVED,
      logger,
    });
  }
}
