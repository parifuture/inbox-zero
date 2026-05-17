import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { ActionType } from "@/generated/prisma/enums";

vi.mock("@/utils/prisma");

vi.mock("@/utils/middleware", () => ({
  withEmailProvider:
    (
      _scope: string,
      handler: (
        request: Request & {
          auth: { emailAccountId: string };
          emailProvider: { name: string };
          logger: {
            info: (...args: unknown[]) => void;
            warn: (...args: unknown[]) => void;
          };
        },
        context: { params: Promise<{ ruleId: string }> },
      ) => Promise<Response>,
    ) =>
    async (
      request: Request,
      context: { params: Promise<{ ruleId: string }> },
    ) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "email-account-1" },
          emailProvider: { name: "google" },
          logger: { info: vi.fn(), warn: vi.fn() },
        }),
        context,
      ),
}));

const batchModify = vi.fn(async () => ({}));

vi.mock("@/utils/email-account-client", () => ({
  getGmailClientForEmail: vi.fn(async () => ({
    users: { messages: { batchModify } },
  })),
}));

const getMessages = vi.fn();
vi.mock("@/utils/gmail/message", () => ({
  getMessages: (...args: unknown[]) => getMessages(...args),
}));

vi.mock("@/utils/gmail/errors", () => ({
  runGmailOp: async <T>(fn: () => Promise<T>) => fn(),
}));

const getKillSwitchStatus = vi.fn(async () => ({ paused: false }));
vi.mock("@/utils/kill-switch", () => ({
  getKillSwitchStatus: (...args: unknown[]) => getKillSwitchStatus(...args),
}));

import { POST } from "./route";

function makeRequest() {
  return new Request("http://localhost/api/rules/r1/apply-historical", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

function makeContext(ruleId: string) {
  return { params: Promise.resolve({ ruleId }) };
}

describe("POST /api/rules/[ruleId]/apply-historical (EL-454)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchModify.mockClear();
    getMessages.mockReset();
    getKillSwitchStatus.mockReset();
    getKillSwitchStatus.mockResolvedValue({ paused: false });
  });

  it("archives historical mail when rule is sender-locked + has ARCHIVE action", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      from: "service@paypal.com",
      lockedToSenderId: "service@paypal.com",
      actions: [{ type: ActionType.ARCHIVE }],
    } as never);
    getMessages.mockResolvedValueOnce({
      messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      nextPageToken: undefined,
    });

    const res = await POST(makeRequest(), makeContext("r1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ applied: true, archived: 3, trashed: 0 });
    expect(batchModify).toHaveBeenCalledTimes(1);
    const call = batchModify.mock.calls[0][0] as {
      requestBody: { addLabelIds?: string[]; removeLabelIds: string[] };
    };
    expect(call.requestBody.removeLabelIds).toEqual(["INBOX"]);
    // Phase 1 invariant: never add TRASH from this endpoint.
    expect(call.requestBody.addLabelIds).toBeUndefined();
  });

  it("rejects rules without lockedToSenderId (not sender-locked)", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      from: "@example.com",
      lockedToSenderId: null,
      actions: [{ type: ActionType.ARCHIVE }],
    } as never);

    const res = await POST(makeRequest(), makeContext("r1"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({
      applied: false,
      archived: 0,
      trashed: 0,
      reason: "not_sender_locked",
    });
    expect(batchModify).not.toHaveBeenCalled();
  });

  it("returns 404 when the rule does not exist", async () => {
    prisma.rule.findUnique.mockResolvedValue(null);

    const res = await POST(makeRequest(), makeContext("missing"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({
      applied: false,
      archived: 0,
      trashed: 0,
      reason: "rule_not_found",
    });
  });

  it("returns applied=false with reason=unsupported_action when rule has no ARCHIVE action", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      from: "service@paypal.com",
      lockedToSenderId: "service@paypal.com",
      actions: [{ type: ActionType.LABEL }, { type: ActionType.MARK_READ }],
    } as never);

    const res = await POST(makeRequest(), makeContext("r1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      applied: false,
      archived: 0,
      trashed: 0,
      reason: "unsupported_action",
    });
    expect(batchModify).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("short-circuits when EL-370 kill-switch is paused", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      from: "service@paypal.com",
      lockedToSenderId: "service@paypal.com",
      actions: [{ type: ActionType.ARCHIVE }],
    } as never);
    getKillSwitchStatus.mockResolvedValueOnce({ paused: true });

    const res = await POST(makeRequest(), makeContext("r1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      applied: false,
      archived: 0,
      trashed: 0,
      reason: "kill_switch_paused",
      killSwitchPaused: true,
    });
    expect(batchModify).not.toHaveBeenCalled();
  });

  it("paginates through Gmail when nextPageToken is set", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      from: "service@paypal.com",
      lockedToSenderId: "service@paypal.com",
      actions: [{ type: ActionType.ARCHIVE }],
    } as never);
    getMessages
      .mockResolvedValueOnce({
        messages: [{ id: "m1" }, { id: "m2" }],
        nextPageToken: "page-2",
      })
      .mockResolvedValueOnce({
        messages: [{ id: "m3" }],
        nextPageToken: undefined,
      });

    const res = await POST(makeRequest(), makeContext("r1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ applied: true, archived: 3, trashed: 0 });
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(batchModify).toHaveBeenCalledTimes(2);
  });

  it("only fetches the rule scoped to the requesting account (multi-tenant guard)", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "r1",
      from: "service@paypal.com",
      lockedToSenderId: "service@paypal.com",
      actions: [{ type: ActionType.ARCHIVE }],
    } as never);
    getMessages.mockResolvedValueOnce({
      messages: [],
      nextPageToken: undefined,
    });

    await POST(makeRequest(), makeContext("r1"));

    expect(prisma.rule.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1", emailAccountId: "email-account-1" },
      }),
    );
  });
});
