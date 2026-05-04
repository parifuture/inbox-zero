import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { applySenderDecisionGate } from "./sender-decision-gate";
import { createTestLogger } from "@/__tests__/helpers";

vi.mock("@/utils/prisma");

const logger = createTestLogger();

function makeMessage(overrides?: Partial<{ from: string }>) {
  return {
    id: "msg-1",
    threadId: "thread-1",
    historyId: "h-1",
    date: "Mon, 1 Jan 2026 12:00:00 +0000",
    snippet: "",
    subject: "Hi",
    inline: [],
    attachments: [],
    labelIds: [],
    headers: {
      from: overrides?.from ?? '"Marketing" <Noreply+promo@Marketing.Example>',
      to: "user@example.com",
      subject: "Hi",
      date: "Mon, 1 Jan 2026 12:00:00 +0000",
      "message-id": "<msg-1>",
    },
  } as any;
}

function makeProvider() {
  return {
    trashThread: vi.fn().mockResolvedValue(undefined),
    archiveMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("applySenderDecisionGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns gated=false when no SenderDecision row exists", async () => {
    prisma.senderDecision.findUnique.mockResolvedValueOnce(null);

    const provider = makeProvider();
    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage(),
      provider,
      logger,
    });

    expect(result).toEqual({ gated: false });
    expect(provider.trashThread).not.toHaveBeenCalled();
    expect(provider.archiveMessage).not.toHaveBeenCalled();
  });

  it("falls through when decision is 'review'", async () => {
    prisma.senderDecision.findUnique.mockResolvedValueOnce({
      id: "sd-1",
      action: "review",
      senderEmail: "noreply@marketing.example",
    } as any);

    const provider = makeProvider();
    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage(),
      provider,
      logger,
    });

    expect(result).toEqual({ gated: false });
    expect(prisma.executedRule.create).not.toHaveBeenCalled();
  });

  it("auto_trash short-circuits, trashes the thread, does NOT call LLM path, and records ExecutedRule", async () => {
    prisma.senderDecision.findUnique.mockResolvedValueOnce({
      id: "sd-1",
      action: "auto_trash",
      senderEmail: "noreply@marketing.example",
    } as any);
    prisma.executedRule.create.mockResolvedValueOnce({
      id: "er-1",
    } as any);
    prisma.senderDecision.update.mockResolvedValueOnce({} as any);

    const provider = makeProvider();
    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage(),
      provider,
      logger,
    });

    expect(result).toMatchObject({
      gated: true,
      action: "auto_trash",
      executedRuleId: "er-1",
    });
    expect(provider.trashThread).toHaveBeenCalledWith(
      "thread-1",
      "",
      "automation",
    );
    expect(provider.archiveMessage).not.toHaveBeenCalled();
    expect(prisma.executedRule.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.executedRule.create.mock.calls[0][0];
    expect(createArg.data.status).toBe("APPLIED");
    expect(createArg.data.reason).toBe("sender_decision:auto_trash");
  });

  it("auto_archive calls archiveMessage, NOT trashThread", async () => {
    prisma.senderDecision.findUnique.mockResolvedValueOnce({
      id: "sd-2",
      action: "auto_archive",
      senderEmail: "noreply@marketing.example",
    } as any);
    prisma.executedRule.create.mockResolvedValueOnce({
      id: "er-2",
    } as any);
    prisma.senderDecision.update.mockResolvedValueOnce({} as any);

    const provider = makeProvider();
    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage(),
      provider,
      logger,
    });

    expect(result).toMatchObject({ gated: true, action: "auto_archive" });
    expect(provider.archiveMessage).toHaveBeenCalledWith("msg-1");
    expect(provider.trashThread).not.toHaveBeenCalled();
  });

  it("always_keep records ExecutedRule but makes NO provider call", async () => {
    prisma.senderDecision.findUnique.mockResolvedValueOnce({
      id: "sd-3",
      action: "always_keep",
      senderEmail: "vip@friend.com",
    } as any);
    prisma.executedRule.create.mockResolvedValueOnce({
      id: "er-3",
    } as any);
    prisma.senderDecision.update.mockResolvedValueOnce({} as any);

    const provider = makeProvider();
    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage({ from: "VIP <vip@friend.com>" }),
      provider,
      logger,
    });

    expect(result).toMatchObject({ gated: true, action: "always_keep" });
    expect(provider.trashThread).not.toHaveBeenCalled();
    expect(provider.archiveMessage).not.toHaveBeenCalled();
    expect(prisma.executedRule.create).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes the From header before lookup (+tag, case, display name)", async () => {
    prisma.senderDecision.findUnique.mockResolvedValueOnce(null);

    await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage({
        from: '"Marketing" <Noreply+promo@Marketing.Example>',
      }),
      provider: makeProvider(),
      logger,
    });

    expect(prisma.senderDecision.findUnique).toHaveBeenCalledWith({
      where: {
        emailAccountId_senderEmail: {
          emailAccountId: "ea-1",
          senderEmail: "noreply@marketing.example",
        },
      },
    });
  });

  it("bails out if the provider call fails (no ExecutedRule written)", async () => {
    prisma.senderDecision.findUnique.mockResolvedValueOnce({
      id: "sd-err",
      action: "auto_trash",
      senderEmail: "noreply@marketing.example",
    } as any);

    const provider = makeProvider();
    provider.trashThread.mockRejectedValueOnce(new Error("gmail 429"));

    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage(),
      provider,
      logger,
    });

    expect(result).toEqual({ gated: false });
    expect(prisma.executedRule.create).not.toHaveBeenCalled();
  });
});
