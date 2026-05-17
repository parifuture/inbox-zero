import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType, GroupItemType } from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";
import { createRuleTool } from "./tools/rules/create-rule-tool";

vi.mock("server-only", () => ({}));

const {
  mockCreateRule,
  mockOutboundActionsNeedChatRiskConfirmation,
  mockPrisma,
} = vi.hoisted(() => ({
  mockCreateRule: vi.fn(),
  mockOutboundActionsNeedChatRiskConfirmation: vi.fn(),
  mockPrisma: {
    rule: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/utils/prisma", () => ({
  default: mockPrisma,
}));

vi.mock("@/utils/rule/rule", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/rule/rule")>();

  return {
    ...actual,
    createRule: mockCreateRule,
    outboundActionsNeedChatRiskConfirmation:
      mockOutboundActionsNeedChatRiskConfirmation,
  };
});

const logger = createScopedLogger("chat-rule-tools-test");

const defaultActions = [
  {
    type: ActionType.LABEL,
    fields: { label: "Action" },
    delayInMinutes: null,
  },
];

describe("createRuleTool overlap guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOutboundActionsNeedChatRiskConfirmation.mockReturnValue({
      needsConfirmation: false,
      riskMessages: [],
    });
    mockCreateRule.mockResolvedValue({ id: "new-rule-id" });
    mockPrisma.rule.findMany.mockResolvedValue([
      {
        name: "Team Mail",
        instructions: null,
        from: "@company.example",
        to: null,
        subject: null,
        group: {
          items: [
            {
              value: "store@company.example",
              exclude: true,
              type: GroupItemType.FROM,
            },
          ],
        },
      },
    ]);
  });

  it("blocks overlapping sender-only rules", async () => {
    const result = await createRuleTool({
      email: "user@example.com",
      emailAccountId: "email-account-id",
      provider: "google",
      logger,
    }).execute({
      name: "Action Mail",
      condition: {
        aiInstructions: null,
        static: { from: "@company.example" },
        conditionalOperator: null,
      },
      actions: defaultActions,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('overlaps the existing "Team Mail"');
    expect(mockCreateRule).not.toHaveBeenCalled();
  });

  it("allows sender rules narrowed by semantic instructions", async () => {
    const result = await createRuleTool({
      email: "user@example.com",
      emailAccountId: "email-account-id",
      provider: "google",
      logger,
    }).execute({
      name: "Urgent Action Mail",
      condition: {
        aiInstructions: "Only urgent requests from this sender domain.",
        static: { from: "@company.example" },
        conditionalOperator: null,
      },
      actions: defaultActions,
    });

    expect(result).toEqual({
      success: true,
      ruleId: "new-rule-id",
      // EL-451: createRuleTool returns null when no sender lock is set.
      lockedToSenderId: null,
    });
    expect(mockCreateRule).toHaveBeenCalledOnce();
  });
});

describe("createRuleTool sender-lock (EL-451)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOutboundActionsNeedChatRiskConfirmation.mockReturnValue({
      needsConfirmation: false,
      riskMessages: [],
    });
    mockCreateRule.mockResolvedValue({ id: "new-rule-id" });
    // No conflicting rules in the account.
    mockPrisma.rule.findMany.mockResolvedValue([]);
  });

  it("forces condition.from to senderLockEmail and persists lockedToSenderId", async () => {
    const result = await createRuleTool({
      email: "user@example.com",
      emailAccountId: "email-account-id",
      provider: "google",
      logger,
      senderLockEmail: "service@paypal.com",
    }).execute({
      name: "PayPal",
      condition: {
        aiInstructions: null,
        // LLM proposed a different/broader pattern — server should override.
        static: { from: "@example.com" },
        conditionalOperator: null,
      },
      actions: defaultActions,
    });

    expect(result).toEqual({
      success: true,
      ruleId: "new-rule-id",
      lockedToSenderId: "service@paypal.com",
    });
    expect(mockCreateRule).toHaveBeenCalledOnce();
    const args = mockCreateRule.mock.calls[0][0];
    expect(args.lockedToSenderId).toBe("service@paypal.com");
    expect(args.result.condition.static.from).toBe("service@paypal.com");
  });

  it("propagates lockedToSenderId in the requiresConfirmation path", async () => {
    mockOutboundActionsNeedChatRiskConfirmation.mockReturnValue({
      needsConfirmation: true,
      riskMessages: ["This rule sends email automatically."],
    });

    const result = await createRuleTool({
      email: "user@example.com",
      emailAccountId: "email-account-id",
      provider: "google",
      logger,
      senderLockEmail: "billing@stripe.com",
    }).execute({
      name: "Stripe billing",
      condition: {
        aiInstructions: null,
        static: { from: "foo@bar.com" },
        conditionalOperator: null,
      },
      actions: [
        {
          type: ActionType.REPLY,
          fields: { content: "Thanks for the invoice" },
          delayInMinutes: null,
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationState).toBe("pending");
    expect(result.lockedToSenderId).toBe("billing@stripe.com");
    expect(mockCreateRule).not.toHaveBeenCalled(); // pending confirmation
  });

  it("returns lockedToSenderId=null when no sender lock is set (regression guard)", async () => {
    const result = await createRuleTool({
      email: "user@example.com",
      emailAccountId: "email-account-id",
      provider: "google",
      logger,
    }).execute({
      name: "Something",
      condition: {
        aiInstructions: null,
        static: { from: "@open.example" },
        conditionalOperator: null,
      },
      actions: defaultActions,
    });

    expect(result.lockedToSenderId).toBeNull();
    const args = mockCreateRule.mock.calls[0][0];
    expect(args.lockedToSenderId).toBeNull();
    expect(args.result.condition.static.from).toBe("@open.example");
  });
});
