import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { applySenderDecisionGate } from "./sender-decision-gate";
import { createTestLogger } from "@/__tests__/helpers";

vi.mock("@/utils/prisma");

const logger = createTestLogger();

function makeMessage(
  overrides?: Partial<{ from: string; labelIds: string[] }>,
) {
  return {
    id: "msg-1",
    threadId: "thread-1",
    historyId: "h-1",
    date: "Mon, 1 Jan 2026 12:00:00 +0000",
    snippet: "",
    subject: "Hi",
    inline: [],
    attachments: [],
    labelIds: overrides?.labelIds ?? [],
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
    labelMessage: vi.fn().mockResolvedValue({}),
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

  it("skips STARRED messages even when sender has auto_trash decision (safety guard)", async () => {
    const provider = makeProvider();
    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage({
        from: "Marketing <noreply@marketing.example>",
        labelIds: ["INBOX", "STARRED"],
      }),
      provider,
      logger,
    });

    expect(result).toEqual({ gated: false });
    // Critical: we must NOT even look up the SenderDecision — starred
    // messages take the normal rules path regardless of any auto_trash
    // decision on the sender.
    expect(prisma.senderDecision.findUnique).not.toHaveBeenCalled();
    expect(provider.trashThread).not.toHaveBeenCalled();
    expect(provider.archiveMessage).not.toHaveBeenCalled();
    expect(prisma.executedRule.create).not.toHaveBeenCalled();
  });

  it("skips STARRED messages even for auto_archive", async () => {
    const provider = makeProvider();
    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage({
        from: "Marketing <noreply@marketing.example>",
        labelIds: ["STARRED", "INBOX"],
      }),
      provider,
      logger,
    });
    expect(result).toEqual({ gated: false });
    expect(provider.archiveMessage).not.toHaveBeenCalled();
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

  it("always_keep with keepLabelId applies the label via provider.labelMessage", async () => {
    prisma.senderDecision.findUnique.mockResolvedValueOnce({
      id: "sd-kl",
      action: "always_keep",
      source: "user",
      senderEmail: "vip@friend.com",
      keepLabelId: "Label_42",
      keepLabelName: "VIP",
    } as any);
    prisma.executedRule.create.mockResolvedValueOnce({ id: "er-kl" } as any);
    prisma.senderDecision.update.mockResolvedValueOnce({} as any);

    const provider = makeProvider();
    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage({ from: "VIP <vip@friend.com>" }),
      provider,
      logger,
    });

    expect(result).toMatchObject({ gated: true, action: "always_keep" });
    expect(provider.labelMessage).toHaveBeenCalledWith({
      messageId: "msg-1",
      labelId: "Label_42",
      labelName: "VIP",
    });
    expect(provider.trashThread).not.toHaveBeenCalled();
    expect(provider.archiveMessage).not.toHaveBeenCalled();
  });

  it("always_keep without keepLabelId does NOT call labelMessage", async () => {
    prisma.senderDecision.findUnique.mockResolvedValueOnce({
      id: "sd-nokl",
      action: "always_keep",
      source: "user",
      senderEmail: "vip@friend.com",
      keepLabelId: null,
      keepLabelName: null,
    } as any);
    prisma.executedRule.create.mockResolvedValueOnce({ id: "er-nokl" } as any);
    prisma.senderDecision.update.mockResolvedValueOnce({} as any);

    const provider = makeProvider();
    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage({ from: "VIP <vip@friend.com>" }),
      provider,
      logger,
    });

    expect(result).toMatchObject({ gated: true, action: "always_keep" });
    expect(provider.labelMessage).not.toHaveBeenCalled();
  });

  it("keep_label.invalid: clears keepLabelId when Gmail returns label-not-found and still records ExecutedRule", async () => {
    prisma.senderDecision.findUnique
      // First call: gate lookup.
      .mockResolvedValueOnce({
        id: "sd-bad",
        action: "always_keep",
        source: "user",
        senderEmail: "vip@friend.com",
        keepLabelId: "Label_Deleted",
        keepLabelName: "Gone",
      } as any)
      // Second call: inside changeSenderDecision → before-snapshot.
      .mockResolvedValueOnce({
        id: "sd-bad",
        action: "always_keep",
        source: "user",
        senderEmail: "vip@friend.com",
        keepLabelId: "Label_Deleted",
        keepLabelName: "Gone",
      } as any);
    prisma.senderDecision.upsert.mockResolvedValueOnce({
      id: "sd-bad",
      action: "always_keep",
      senderEmail: "vip@friend.com",
      source: "user",
      keepLabelId: null,
      keepLabelName: null,
    } as any);
    prisma.executedRule.create.mockResolvedValueOnce({ id: "er-bad" } as any);
    prisma.senderDecision.update.mockResolvedValueOnce({} as any);

    const provider = makeProvider();
    provider.labelMessage.mockRejectedValueOnce(
      Object.assign(new Error("Requested entity was not found."), {
        status: 404,
      }),
    );

    const result = await applySenderDecisionGate({
      emailAccountId: "ea-1",
      message: makeMessage({ from: "VIP <vip@friend.com>" }),
      provider,
      logger,
    });

    // Keep still succeeds — label-not-found is recoverable, not a keep failure.
    expect(result).toMatchObject({ gated: true, action: "always_keep" });
    expect(prisma.executedRule.create).toHaveBeenCalledTimes(1);
    // Decision was updated to clear keepLabelId/Name via changeSenderDecision → upsert.
    expect(prisma.senderDecision.upsert).toHaveBeenCalled();
    const upsertArg = prisma.senderDecision.upsert.mock.calls[0][0];
    expect(upsertArg.update.keepLabelId).toBeNull();
    expect(upsertArg.update.keepLabelName).toBeNull();
  });
});
