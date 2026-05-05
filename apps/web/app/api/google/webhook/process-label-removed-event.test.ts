import { vi, describe, it, expect, beforeEach } from "vitest";
import { HistoryEventType } from "./types";
import { handleLabelRemovedEvent } from "./process-label-removed-event";
import type { gmail_v1 } from "@googleapis/gmail";
import { saveLearnedPattern } from "@/utils/rule/learned-patterns";
import { SystemType } from "@/generated/prisma/enums";
import { createTestLogger } from "@/__tests__/helpers";
import { findRuleByLabelId } from "@/utils/rule/classification-feedback";

const logger = createTestLogger();

vi.mock("server-only", () => ({}));

// Mock dependencies
vi.mock("@/utils/prisma", () => ({
  default: {
    rule: {
      findFirst: vi.fn(),
    },
    groupItem: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

vi.mock("@/utils/rule/learned-patterns", () => ({
  saveLearnedPattern: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@/utils/rule/classification-feedback", () => ({
  saveClassificationFeedback: vi.fn().mockResolvedValue(undefined),
  findRuleByLabelId: vi.fn(),
}));

vi.mock("@/utils/rule/consts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/rule/consts")>();
  return {
    ...actual,
    isEligibleForClassificationFeedback: vi.fn().mockReturnValue(true),
  };
});

describe("process-label-removed-event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createLabelRemovedHistoryItem = (
    messageId = "123",
    threadId = "thread-123",
    labelIds = ["label-1"],
  ) => ({
    type: HistoryEventType.LABEL_REMOVED,
    item: {
      message: { id: messageId, threadId },
      labelIds,
    } as gmail_v1.Schema$HistoryLabelRemoved,
  });

  const mockEmailAccount = {
    id: "email-account-id",
    email: "user@test.com",
  } as any;
  const mockProvider = {
    getMessage: vi.fn().mockResolvedValue({
      headers: {
        from: "sender@example.com",
      },
    }),
    getLabels: vi.fn().mockResolvedValue([
      { id: "label-1", name: "Cold Email", type: "user" },
      { id: "label-2", name: "Newsletter", type: "user" },
      { id: "label-3", name: "Marketing", type: "user" },
      { id: "label-4", name: "To Reply", type: "user" },
    ]),
  } as any;

  const defaultOptions = {
    emailAccount: mockEmailAccount,
    provider: mockProvider,
  };

  describe("handleLabelRemovedEvent", () => {
    it("should skip learning when To Reply label is removed (not a learnable rule)", async () => {
      vi.mocked(findRuleByLabelId).mockResolvedValue({
        id: "rule-456",
        systemType: SystemType.TO_REPLY,
      } as any);

      const historyItem = createLabelRemovedHistoryItem("123", "thread-123", [
        "label-4",
      ]);

      await handleLabelRemovedEvent(historyItem.item, defaultOptions, logger);

      expect(saveLearnedPattern).not.toHaveBeenCalled();
    });

    it("should skip processing when only system labels are removed", async () => {
      const historyItem = {
        message: { id: "msg-123", threadId: "thread-123" },
        labelIds: ["INBOX", "UNREAD"], // Only system labels
      } as gmail_v1.Schema$HistoryLabelRemoved;

      await handleLabelRemovedEvent(historyItem, defaultOptions, logger);

      // Should not try to fetch the message when only system labels removed
      expect(mockProvider.getMessage).not.toHaveBeenCalled();
      expect(saveLearnedPattern).not.toHaveBeenCalled();
    });

    it("should skip processing when DRAFT label is removed (prevents 404 errors)", async () => {
      const historyItem = {
        message: { id: "draft-123", threadId: "thread-123" },
        labelIds: ["DRAFT"], // Draft was sent - message no longer exists
      } as gmail_v1.Schema$HistoryLabelRemoved;

      await handleLabelRemovedEvent(historyItem, defaultOptions, logger);

      expect(mockProvider.getMessage).not.toHaveBeenCalled();
      expect(saveLearnedPattern).not.toHaveBeenCalled();
    });

    it("should skip processing when only Gmail category labels are removed", async () => {
      const historyItem = {
        message: { id: "msg-123", threadId: "thread-123" },
        labelIds: ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES"],
      } as gmail_v1.Schema$HistoryLabelRemoved;

      await handleLabelRemovedEvent(historyItem, defaultOptions, logger);

      expect(mockProvider.getMessage).not.toHaveBeenCalled();
      expect(saveLearnedPattern).not.toHaveBeenCalled();
    });

    it("should skip processing when messageId is missing", async () => {
      const historyItem = {
        message: { threadId: "thread-123" }, // Missing messageId
        labelIds: ["label-1"],
      } as gmail_v1.Schema$HistoryLabelRemoved;

      await handleLabelRemovedEvent(historyItem, defaultOptions, logger);

      expect(saveLearnedPattern).not.toHaveBeenCalled();
    });

    it("should skip processing when threadId is missing", async () => {
      const historyItem = {
        message: { id: "123" }, // Missing threadId
        labelIds: ["label-1"],
      } as gmail_v1.Schema$HistoryLabelRemoved;

      await handleLabelRemovedEvent(historyItem, defaultOptions, logger);

      expect(saveLearnedPattern).not.toHaveBeenCalled();
    });

    it("should handle multiple label removals in a single event", async () => {
      vi.mocked(findRuleByLabelId)
        .mockResolvedValueOnce({
          id: "rule-1",
          systemType: SystemType.NOTIFICATION,
        } as any)
        .mockResolvedValueOnce({
          id: "rule-2",
          systemType: SystemType.NEWSLETTER,
        } as any);

      const historyItem = createLabelRemovedHistoryItem("123", "thread-123", [
        "label-1",
        "label-2",
      ]);

      await handleLabelRemovedEvent(historyItem.item, defaultOptions, logger);

      expect(saveLearnedPattern).toHaveBeenCalledTimes(2);
      expect(saveLearnedPattern).toHaveBeenCalledWith(
        expect.objectContaining({ ruleId: "rule-1" }),
      );
      expect(saveLearnedPattern).toHaveBeenCalledWith(
        expect.objectContaining({ ruleId: "rule-2" }),
      );
    });

    it("should skip learning when no rule is found for the removed label", async () => {
      vi.mocked(findRuleByLabelId).mockResolvedValue(null);

      const historyItem = createLabelRemovedHistoryItem("123", "thread-123", [
        "unknown-label",
      ]);

      await handleLabelRemovedEvent(historyItem.item, defaultOptions, logger);

      expect(saveLearnedPattern).not.toHaveBeenCalled();
    });
  });

  // EL-361b: undoSpamLearning test block removed along with the cold email
  // blocker. SPAM → cold-email pattern learning no longer exists.
});
