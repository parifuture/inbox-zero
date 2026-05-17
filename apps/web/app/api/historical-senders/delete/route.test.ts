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

// EL-459: route now uses gmail.users.messages.trash (the proper move-to-Trash
// API) instead of batchModify+addLabelIds:[TRASH]. Adding the TRASH label via
// batchModify is unreliable — Gmail accepts the mutation but doesn't always
// actually move the message to Trash.
const trashMessage = vi.fn(async () => ({}));
const messagesDelete = vi.fn(async () => ({}));

vi.mock("@/utils/email-account-client", () => ({
  getGmailClientForEmail: vi.fn(async () => ({
    users: {
      messages: {
        trash: trashMessage,
        // delete intentionally not exposed — Phase 1 invariant: never permanent.
      },
    },
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

describe("POST /api/historical-senders/delete (EL-438 + EL-459)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trashMessage.mockClear();
    messagesDelete.mockClear();
    getMessages.mockReset();
    getKillSwitchStatus.mockReset();
    getKillSwitchStatus.mockResolvedValue({ paused: false });
    prisma.historicalSender.update.mockResolvedValue({} as never);
  });

  it("moves each matched message to Trash via users.messages.trash and updates deletedAt", async () => {
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

    // EL-459 critical: must call users.messages.trash (the actual Trash
    // API), one call per message id. NEVER messages.delete (permanent).
    expect(trashMessage).toHaveBeenCalledTimes(3);
    expect(trashMessage).toHaveBeenNthCalledWith(1, {
      userId: "me",
      id: "m1",
    });
    expect(trashMessage).toHaveBeenNthCalledWith(2, {
      userId: "me",
      id: "m2",
    });
    expect(trashMessage).toHaveBeenNthCalledWith(3, {
      userId: "me",
      id: "m3",
    });
    expect(messagesDelete).not.toHaveBeenCalled();

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

  it("never invokes permanent delete (defence-in-depth)", async () => {
    getMessages.mockResolvedValueOnce({
      messages: [{ id: "only-1" }],
      nextPageToken: undefined,
    });
    const res = await POST(makeRequest({ senderEmails: ["safe@spam.test"] }));
    expect(res.status).toBe(200);
    expect(trashMessage).toHaveBeenCalledTimes(1);
    expect(messagesDelete).not.toHaveBeenCalled();
  });

  it("paginates across multiple pages and trashes every message", async () => {
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
    // EL-459: per-message API → exactly 1700 calls (one per id).
    expect(trashMessage).toHaveBeenCalledTimes(1700);
    expect(messagesDelete).not.toHaveBeenCalled();
  });

  it("rejects empty senderEmails (zod validation)", async () => {
    await expect(POST(makeRequest({ senderEmails: [] }))).rejects.toThrow(
      /Too small/,
    );
    expect(trashMessage).not.toHaveBeenCalled();
  });

  it("short-circuits when EL-370 kill-switch is paused (no Gmail mutation)", async () => {
    getKillSwitchStatus.mockResolvedValueOnce({ paused: true });
    const res = await POST(makeRequest({ senderEmails: ["junk@spam.test"] }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ trashed: [], killSwitchPaused: true });
    expect(trashMessage).not.toHaveBeenCalled();
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
    expect(trashMessage).toHaveBeenCalledTimes(1);
  });
});
