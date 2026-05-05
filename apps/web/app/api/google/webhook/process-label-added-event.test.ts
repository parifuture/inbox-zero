import { vi, describe, it, expect, beforeEach } from "vitest";
import { handleLabelAddedEvent } from "./process-label-added-event";
import type { gmail_v1 } from "@googleapis/gmail";
import { saveLearnedPattern } from "@/utils/rule/learned-patterns";
import { createTestLogger } from "@/__tests__/helpers";
import { saveClassificationFeedback } from "@/utils/rule/classification-feedback";
import { fetchSenderFromMessage } from "@/app/api/google/webhook/fetch-sender-from-message";

const logger = createTestLogger();

vi.mock("server-only", () => ({}));

vi.mock("@/utils/prisma", () => ({
  default: {
    rule: {
      findFirst: vi.fn(),
    },
    groupItem: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    executedAction: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/utils/rule/learned-patterns", () => ({
  saveLearnedPattern: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/rule/classification-feedback", () => ({
  saveClassificationFeedback: vi.fn().mockResolvedValue(undefined),
  findRuleByLabelId: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/utils/gmail/label", () => ({
  GmailLabel: {
    INBOX: "INBOX",
    SENT: "SENT",
    UNREAD: "UNREAD",
    STARRED: "STARRED",
    IMPORTANT: "IMPORTANT",
    SPAM: "SPAM",
    TRASH: "TRASH",
    DRAFT: "DRAFT",
    PERSONAL: "CATEGORY_PERSONAL",
    SOCIAL: "CATEGORY_SOCIAL",
    PROMOTIONS: "CATEGORY_PROMOTIONS",
    FORUMS: "CATEGORY_FORUMS",
    UPDATES: "CATEGORY_UPDATES",
  },
  GMAIL_SYSTEM_LABELS: [
    "INBOX",
    "SENT",
    "DRAFT",
    "SPAM",
    "TRASH",
    "IMPORTANT",
    "STARRED",
    "UNREAD",
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_FORUMS",
    "CATEGORY_UPDATES",
  ],
}));

vi.mock("@/utils/email", () => ({
  extractEmailAddress: vi.fn().mockReturnValue("sender@example.com"),
}));

vi.mock("@/app/api/google/webhook/fetch-sender-from-message", () => ({
  fetchSenderFromMessage: vi.fn().mockResolvedValue("sender@example.com"),
}));

vi.mock("@/utils/rule/consts", () => ({
  isEligibleForClassificationFeedback: vi.fn().mockReturnValue(true),
}));

describe("process-label-added-event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createLabelAddedItem = (
    messageId = "123",
    threadId = "thread-123",
    labelIds = ["SPAM"],
  ) =>
    ({
      message: { id: messageId, threadId },
      labelIds,
    }) as gmail_v1.Schema$HistoryLabelAdded;

  const mockEmailAccount = {
    id: "email-account-id",
    email: "user@test.com",
  } as any;

  const mockProvider = {
    getMessage: vi.fn().mockResolvedValue({
      headers: { from: "sender@example.com" },
    }),
  } as any;

  const defaultOptions = {
    emailAccount: mockEmailAccount,
    provider: mockProvider,
  };

  describe("handleLabelAddedEvent", () => {
    // EL-361b: Cold Email Blocker stripped — SPAM → cold-email learning tests
    // removed. Remaining tests cover the classification-feedback path for
    // non-system labels.

    it("should skip when added label is a system label", async () => {
      await handleLabelAddedEvent(
        createLabelAddedItem("123", "thread-123", ["STARRED"]),
        defaultOptions,
        logger,
      );

      expect(saveLearnedPattern).not.toHaveBeenCalled();
      expect(saveClassificationFeedback).not.toHaveBeenCalled();
    });

    it("should skip when added label is a Gmail category label", async () => {
      await handleLabelAddedEvent(
        createLabelAddedItem("123", "thread-123", ["CATEGORY_PROMOTIONS"]),
        defaultOptions,
        logger,
      );

      expect(saveLearnedPattern).not.toHaveBeenCalled();
      expect(saveClassificationFeedback).not.toHaveBeenCalled();
    });

    it("should skip when sender cannot be extracted", async () => {
      vi.mocked(fetchSenderFromMessage).mockResolvedValueOnce(null);

      await handleLabelAddedEvent(
        createLabelAddedItem("123", "thread-123", ["label-1"]),
        defaultOptions,
        logger,
      );

      expect(saveLearnedPattern).not.toHaveBeenCalled();
    });
  });
});
