import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SenderDecision } from "@/generated/prisma/client";

// Mock prisma before importing the module under test.
const mockPrisma = {
  senderDecision: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  senderDecisionAudit: {
    create: vi.fn(),
  },
};

vi.mock("@/utils/prisma", () => ({ default: mockPrisma }));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("@/utils/logger", () => ({
  createScopedLogger: () => mockLogger,
}));

const { changeSenderDecision, deleteSenderDecision } = await import("./change");

function makeDecision(overrides: Partial<SenderDecision> = {}): SenderDecision {
  return {
    id: "dec_1",
    emailAccountId: "ea_1",
    senderEmail: "a@b.com",
    senderDomain: "b.com",
    action: "review",
    source: "user",
    note: null,
    firstSeenAt: null,
    lastSeenAt: null,
    messageCount: 0,
    autoAppliedAt: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  } as SenderDecision;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("changeSenderDecision", () => {
  it("writes an audit row with source + reason + actor on update", async () => {
    const before = makeDecision({ action: "review" });
    const after = makeDecision({ action: "auto_trash", source: "user" });
    mockPrisma.senderDecision.findUnique.mockResolvedValueOnce(before);
    mockPrisma.senderDecision.upsert.mockResolvedValueOnce(after);
    mockPrisma.senderDecisionAudit.create.mockResolvedValueOnce({});

    const result = await changeSenderDecision({
      emailAccountId: "ea_1",
      senderEmail: "A@B.com",
      action: "auto_trash",
      decisionSource: "user",
      auditSource: "ui:decisions",
      reason: "pressed e to cycle",
    });

    expect(result.before).toEqual(before);
    expect(result.after).toEqual(after);
    expect(result.kind).toBe("update");

    expect(mockPrisma.senderDecisionAudit.create).toHaveBeenCalledTimes(1);
    const audit = mockPrisma.senderDecisionAudit.create.mock.calls[0][0].data;
    expect(audit.source).toBe("ui:decisions");
    expect(audit.reason).toBe("pressed e to cycle");
    expect(audit.actor).toBe("user");
    expect(audit.action).toBe("update");

    expect(mockLogger.info).toHaveBeenCalledWith(
      "sender_decision.changed",
      expect.objectContaining({
        kind: "update",
        auditSource: "ui:decisions",
        before: "review",
        after: "auto_trash",
      }),
    );
  });

  it("marks kind=create when no prior row exists", async () => {
    mockPrisma.senderDecision.findUnique.mockResolvedValueOnce(null);
    mockPrisma.senderDecision.upsert.mockResolvedValueOnce(
      makeDecision({ action: "always_keep" }),
    );
    mockPrisma.senderDecisionAudit.create.mockResolvedValueOnce({});

    const result = await changeSenderDecision({
      emailAccountId: "ea_1",
      senderEmail: "a@b.com",
      action: "always_keep",
      decisionSource: "user",
      auditSource: "api:import",
    });
    expect(result.kind).toBe("create");
    expect(
      mockPrisma.senderDecisionAudit.create.mock.calls[0][0].data.action,
    ).toBe("create");
  });

  it("rejects an invalid sender email", async () => {
    await expect(
      changeSenderDecision({
        emailAccountId: "ea_1",
        senderEmail: "not-an-email",
        action: "review",
        decisionSource: "user",
        auditSource: "ui:decisions",
      }),
    ).rejects.toThrow(/Invalid sender address/);
  });
});

describe("deleteSenderDecision", () => {
  it("resets to review and emits sender_decision.deleted log", async () => {
    const before = makeDecision({ action: "auto_trash" });
    const after = makeDecision({ action: "review", source: "user" });
    mockPrisma.senderDecision.findUnique.mockResolvedValueOnce(before);
    mockPrisma.senderDecision.upsert.mockResolvedValueOnce(after);
    mockPrisma.senderDecisionAudit.create.mockResolvedValueOnce({});

    const result = await deleteSenderDecision({
      emailAccountId: "ea_1",
      senderEmail: "a@b.com",
      decisionSource: "user",
      auditSource: "ui:decisions",
      reason: "user hit trash icon",
    });

    expect(result.kind).toBe("delete");
    const audit = mockPrisma.senderDecisionAudit.create.mock.calls[0][0].data;
    expect(audit.action).toBe("delete");
    expect(audit.source).toBe("ui:decisions");
    expect(audit.reason).toBe("user hit trash icon");

    expect(mockLogger.info).toHaveBeenCalledWith(
      "sender_decision.deleted",
      expect.objectContaining({
        auditSource: "ui:decisions",
        previousAction: "auto_trash",
      }),
    );
  });
});
