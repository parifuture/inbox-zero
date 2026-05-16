import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

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
      ) => Promise<Response>,
    ) =>
    async (request: Request) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "email-account-1" },
          emailProvider: { name: "google" },
          logger: { info: vi.fn(), warn: vi.fn() },
        }),
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

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/historical-senders/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/historical-senders/archive (EL-323 + EL-455 kill-switch gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchModify.mockClear();
    getMessages.mockReset();
    getKillSwitchStatus.mockReset();
    getKillSwitchStatus.mockResolvedValue({ paused: false });
    prisma.historicalSender.update.mockResolvedValue({} as never);
  });

  it("archives matched messages (removeLabelIds=[INBOX], no TRASH)", async () => {
    getMessages.mockResolvedValueOnce({
      messages: [{ id: "m1" }, { id: "m2" }],
      nextPageToken: undefined,
    });
    const res = await POST(makeRequest({ senderEmails: ["news@spam.test"] }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({
      archived: [{ senderEmail: "news@spam.test", count: 2 }],
    });
    expect(batchModify).toHaveBeenCalledTimes(1);
    const call = batchModify.mock.calls[0][0] as {
      requestBody: { addLabelIds?: string[]; removeLabelIds: string[] };
    };
    expect(call.requestBody.removeLabelIds).toEqual(["INBOX"]);
    // Archive must NOT add TRASH (that would be Delete, not Archive).
    expect(call.requestBody.addLabelIds).toBeUndefined();
  });

  it("short-circuits when EL-370 kill-switch is paused (no Gmail mutation)", async () => {
    getKillSwitchStatus.mockResolvedValueOnce({ paused: true });
    const res = await POST(makeRequest({ senderEmails: ["news@spam.test"] }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ archived: [], killSwitchPaused: true });
    expect(batchModify).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
    expect(prisma.historicalSender.update).not.toHaveBeenCalled();
  });

  it("falls back to running when kill-switch lookup fails", async () => {
    getKillSwitchStatus.mockRejectedValueOnce(new Error("db down"));
    getMessages.mockResolvedValueOnce({
      messages: [{ id: "m1" }],
      nextPageToken: undefined,
    });
    const res = await POST(makeRequest({ senderEmails: ["x@spam.test"] }));
    expect(res.status).toBe(200);
    expect(batchModify).toHaveBeenCalledTimes(1);
  });

  it("rejects empty senderEmails (zod validation)", async () => {
    await expect(POST(makeRequest({ senderEmails: [] }))).rejects.toThrow(
      /Too small/,
    );
    expect(batchModify).not.toHaveBeenCalled();
  });
});
