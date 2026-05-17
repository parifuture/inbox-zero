import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));

const { mockDeleteRule, mockPrisma } = vi.hoisted(() => ({
  mockDeleteRule: vi.fn(),
  mockPrisma: {
    rule: {
      findFirst: vi.fn(),
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
    deleteRule: mockDeleteRule,
  };
});

import { deleteRuleTool } from "./tools/rules/delete-rule-tool";

const logger = createScopedLogger("delete-rule-tool-test");

// Provide a fresh rule-read state so validateRuleWasReadRecently passes.
// The real chat path calls getUserRulesAndSettings before any rule mutation.
const freshRuleReadState = () => ({
  rulesRevision: 1,
  readAt: Date.now(),
  ruleUpdatedAtByName: new Map([["_marker", new Date().toISOString()]]),
});

const baseOptions = () => ({
  email: "user@example.com",
  emailAccountId: "email-account-id",
  logger,
  getRuleReadState: () => freshRuleReadState(),
});

describe("deleteRuleTool (EL-457)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteRule.mockResolvedValue(undefined);
  });

  it("deletes a disabled rule directly without requiring confirmation", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue({
      id: "r1",
      name: "Old Kickstarter",
      enabled: false,
      groupId: null,
      lockedToSenderId: null,
    } as never);

    const result = await deleteRuleTool(baseOptions()).execute({
      ruleName: "Old Kickstarter",
      confirmed: null,
    });

    expect(result).toEqual({
      success: true,
      ruleName: "Old Kickstarter",
      wasEnabled: false,
    });
    expect(mockDeleteRule).toHaveBeenCalledWith({
      emailAccountId: "email-account-id",
      ruleId: "r1",
      groupId: null,
    });
  });

  it("requires explicit confirmation for an enabled rule", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue({
      id: "r1",
      name: "Live Auto-Trash",
      enabled: true,
      groupId: null,
      lockedToSenderId: null,
    } as never);

    const result = await deleteRuleTool(baseOptions()).execute({
      ruleName: "Live Auto-Trash",
      confirmed: null,
    });

    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.wasEnabled).toBe(true);
    expect(result.error).toContain("currently enabled");
    expect(mockDeleteRule).not.toHaveBeenCalled();
  });

  it("deletes the enabled rule when confirmed:true", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue({
      id: "r1",
      name: "Live Auto-Trash",
      enabled: true,
      groupId: null,
      lockedToSenderId: null,
    } as never);

    const result = await deleteRuleTool(baseOptions()).execute({
      ruleName: "Live Auto-Trash",
      confirmed: true,
    });

    expect(result).toEqual({
      success: true,
      ruleName: "Live Auto-Trash",
      wasEnabled: true,
    });
    expect(mockDeleteRule).toHaveBeenCalledOnce();
  });

  it("returns 'rule not found' when no matching name exists", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue(null);

    const result = await deleteRuleTool(baseOptions()).execute({
      ruleName: "Doesn't exist",
      confirmed: null,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No rule named "Doesn\'t exist"');
    expect(mockDeleteRule).not.toHaveBeenCalled();
  });

  it("forwards groupId so deleteRule can clean up an owning Group", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue({
      id: "r1",
      name: "With Group",
      enabled: false,
      groupId: "g-99",
      lockedToSenderId: null,
    } as never);

    await deleteRuleTool(baseOptions()).execute({
      ruleName: "With Group",
      confirmed: null,
    });

    expect(mockDeleteRule).toHaveBeenCalledWith({
      emailAccountId: "email-account-id",
      ruleId: "r1",
      groupId: "g-99",
    });
  });

  it("scopes lookup to the requesting account (multi-tenant guard)", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue(null);

    await deleteRuleTool(baseOptions()).execute({
      ruleName: "Kickstarter",
      confirmed: null,
    });

    expect(mockPrisma.rule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: "Kickstarter", emailAccountId: "email-account-id" },
      }),
    );
  });

  it("surfaces deleteRule errors without leaking internals", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue({
      id: "r1",
      name: "Boom",
      enabled: false,
      groupId: null,
      lockedToSenderId: null,
    } as never);
    mockDeleteRule.mockRejectedValue(new Error("db down"));

    const result = await deleteRuleTool(baseOptions()).execute({
      ruleName: "Boom",
      confirmed: null,
    });

    expect(result.error).toBe("Failed to delete rule");
    expect(result.message).toBe("db down");
  });
});
