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

function makeRequest(body: unknown, providerOverride?: { name: string }) {
  const req = new Request("http://localhost/api/historical-senders/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (providerOverride) {
    Object.assign(req, { emailProvider: providerOverride });
  }
  return req;
}

describe("POST /api/historical-senders/delete (EL-438)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchModify.mockClear();
    getMessages.mockReset();
    getKillSwitchStatus.mockReset();
    getKillSwitchStatus.mockResolvedValue({ paused: false });
    prisma.historicalSender.update.mockResolvedValue({} as never);
  });

  it("moves matched messages to Trash and updates deletedAt", async () => {
    getMessages.mockResolvedValueOnce({
      messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      nextPageToken: undefined,
    });

    const res = await POST(makeRequest({ senderEmails: ["junk@spam.test"] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      trashed: [{ senderEmail: "junk@spam.test", count: 3 }],
    });

    // Critical: addLabelIds must include TRASH and removeLabelIds must include
    // INBOX. We must NEVER call messages.delete (permanent delete).
    expect(batchModify).toHaveBeenCalledTimes(1);
    expect(batchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        ids: ["m1", "m2", "m3"],
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    });

    expect(prisma.historicalSender.update).toHaveBeenCalledWith({
      where: {
        emailAccountId_senderEmail: {
          emailAccountId: "email-account-1",
          senderEmail: "junk@spam.test",
        },
      },
      data: expect.objectContaining({
        deletedAt: expect.any(Date),
        archivedAt: null,
        skippedAt: null,
      }),
    });
  });

  it("never invokes permanent delete (only batchModify)", async () => {
    // Defence-in-depth check: even when the sender has matched messages,
    // the route must never call gmail.users.messages.delete (permanent).
    // We confirm by inspecting the gmail client — there is no `delete`
    // method on the mocked client, so any reference would throw. We also
    // assert batchModify is the only Gmail mutation invoked.
    getMessages.mockResolvedValueOnce({
      messages: [{ id: "only-1" }],
      nextPageToken: undefined,
    });
    const res = await POST(makeRequest({ senderEmails: ["safe@spam.test"] }));
    expect(res.status).toBe(200);
    expect(batchModify).toHaveBeenCalledTimes(1);
    // Belt-and-suspenders: the call we made was a label-mutation, not a
    // permanent delete.
    const call = batchModify.mock.calls[0][0] as {
      requestBody: { addLabelIds: string[] };
    };
    expect(call.requestBody.addLabelIds).toContain("TRASH");
  });

  it("paginates across multiple pages and chunks large id sets", async () => {
    const firstPage = Array.from({ length: 1500 }, (_, i) => ({
      id: `m-page1-${i}`,
    }));
    const secondPage = Array.from({ length: 200 }, (_, i) => ({
      id: `m-page2-${i}`,
    }));

    getMessages
      .mockResolvedValueOnce({
        messages: firstPage,
        nextPageToken: "next-token",
      })
      .mockResolvedValueOnce({
        messages: secondPage,
        nextPageToken: undefined,
      });

    const res = await POST(makeRequest({ senderEmails: ["bulk@spam.test"] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.trashed[0]).toEqual({
      senderEmail: "bulk@spam.test",
      count: 1700,
    });
    // 1500 → chunked into 1000 + 500 = 2 calls. 200 → 1 call. Total = 3.
    expect(batchModify).toHaveBeenCalledTimes(3);
    // Every call must use TRASH + INBOX semantics.
    for (const call of batchModify.mock.calls) {
      const reqBody = call[0] as {
        requestBody: { addLabelIds: string[]; removeLabelIds: string[] };
      };
      expect(reqBody.requestBody.addLabelIds).toEqual(["TRASH"]);
      expect(reqBody.requestBody.removeLabelIds).toEqual(["INBOX"]);
    }
  });

  it("rejects empty senderEmails (zod validation)", async () => {
    await expect(POST(makeRequest({ senderEmails: [] }))).rejects.toThrow(
      /Too small/,
    );
    expect(batchModify).not.toHaveBeenCalled();
  });

  it("short-circuits when EL-370 kill-switch is paused (no Gmail mutation)", async () => {
    getKillSwitchStatus.mockResolvedValueOnce({ paused: true });
    const res = await POST(makeRequest({ senderEmails: ["junk@spam.test"] }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ trashed: [], killSwitchPaused: true });
    expect(batchModify).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
    expect(prisma.historicalSender.update).not.toHaveBeenCalled();
  });

  it("falls back to running when kill-switch lookup fails", async () => {
    // .catch fallback — worst-case the route runs as today; never blocks
    // a human-driven action because of an infrastructure hiccup.
    getKillSwitchStatus.mockRejectedValueOnce(new Error("db down"));
    getMessages.mockResolvedValueOnce({
      messages: [{ id: "m1" }],
      nextPageToken: undefined,
    });
    const res = await POST(makeRequest({ senderEmails: ["x@spam.test"] }));
    expect(res.status).toBe(200);
    expect(batchModify).toHaveBeenCalledTimes(1);
  });
});
