import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/utils/prisma", () => ({
  default: {
    senderDecision: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("@/utils/middleware", () => ({
  withEmailAccount:
    (
      _scope: string,
      handler: (
        request: Request & { auth: { emailAccountId: string } },
        ctx: unknown,
      ) => Promise<Response>,
    ) =>
    async (request: Request) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "email-account-1" },
        }),
        {},
      ),
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
// EL-459: trash via users.messages.trash, not batchModify+addLabelIds:[TRASH].
const trashMessage = vi.fn(async () => ({}));

vi.mock("@/utils/email-account-client", () => ({
  getGmailClientForEmail: vi.fn(async () => ({
    users: { messages: { batchModify, trash: trashMessage } },
  })),
}));

const getMessages = vi.fn();
vi.mock("@/utils/gmail/message", () => ({
  getMessages: (...args: unknown[]) => getMessages(...args),
}));

vi.mock("@/utils/gmail/errors", () => ({
  runGmailOp: async <T>(fn: () => Promise<T>) => fn(),
  GmailPipelineError: class extends Error {},
  GmailErrorKind: { NotFound: "NotFound" },
}));

const getKillSwitchStatus = vi.fn(async () => ({ paused: false }));
vi.mock("@/utils/kill-switch", () => ({
  getKillSwitchStatus: (...args: unknown[]) => getKillSwitchStatus(...args),
}));

const changeSenderDecision = vi.fn(async () => ({
  before: null,
  after: {} as never,
  kind: "create",
}));
const deleteSenderDecision = vi.fn(async () => ({
  before: null,
  after: {} as never,
  kind: "delete",
}));
vi.mock("@/utils/sender-decision/change", () => ({
  changeSenderDecision: (...args: unknown[]) => changeSenderDecision(...args),
  deleteSenderDecision: (...args: unknown[]) => deleteSenderDecision(...args),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/senders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/senders (EL-442 four-actions)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchModify.mockClear();
    trashMessage.mockClear();
    getMessages.mockReset();
    getKillSwitchStatus.mockResolvedValue({ paused: false });
  });

  it("archive_forever writes auto_archive via changeSenderDecision and Gmail-archives existing mail", async () => {
    getMessages.mockResolvedValueOnce({
      messages: [{ id: "m1" }, { id: "m2" }],
      nextPageToken: undefined,
    });

    const res = await POST(
      makeRequest({
        senderEmail: "Newsletter <news@example.com>",
        action: "archive_forever",
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.action).toBe("archive_forever");
    expect(json.retroactiveApplied).toBe(2);

    // Persistence: SenderDecision.action='auto_archive' via the audited helper
    expect(changeSenderDecision).toHaveBeenCalledTimes(1);
    expect(changeSenderDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "email-account-1",
        senderEmail: "news@example.com", // canonicalized
        action: "auto_archive",
        decisionSource: "user",
        auditSource: "ui:senders-page",
        allowOverwriteUser: true,
      }),
    );
    expect(deleteSenderDecision).not.toHaveBeenCalled();

    // Retroactive: removeLabelIds:[INBOX] only — never TRASH
    expect(batchModify).toHaveBeenCalledTimes(1);
    expect(batchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { ids: ["m1", "m2"], removeLabelIds: ["INBOX"] },
    });
  });

  it("delete writes auto_trash and trashes existing mail (NEVER permanent delete)", async () => {
    getMessages.mockResolvedValueOnce({
      messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      nextPageToken: undefined,
    });

    const res = await POST(
      makeRequest({ senderEmail: "spam@bad.test", action: "delete" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.action).toBe("delete");
    expect(json.retroactiveApplied).toBe(3);

    expect(changeSenderDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        senderEmail: "spam@bad.test",
        action: "auto_trash",
        auditSource: "ui:senders-page",
      }),
    );

    // EL-459: Trash semantics use users.messages.trash (per id), NOT
    // batchModify+addLabelIds:[TRASH] (which is unreliable). NEVER
    // messages.delete (permanent).
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
    expect(batchModify).not.toHaveBeenCalled();
  });

  it("custom_rule maps to review (placeholder until EL-439) and skips Gmail batchModify", async () => {
    const res = await POST(
      makeRequest({
        senderEmail: "shop@retailer.test",
        action: "custom_rule",
        retroactive: true,
      }),
    );
    expect(res.status).toBe(200);

    expect(changeSenderDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review",
        auditSource: "ui:senders-page",
      }),
    );
    // No Gmail mutation for custom_rule even when retroactive=true
    expect(batchModify).not.toHaveBeenCalled();
  });

  it("none deletes the SenderDecision row and skips Gmail", async () => {
    const res = await POST(
      makeRequest({ senderEmail: "neutral@example.com", action: "none" }),
    );
    expect(res.status).toBe(200);

    expect(deleteSenderDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "email-account-1",
        senderEmail: "neutral@example.com",
        auditSource: "ui:senders-page",
        allowOverwriteUser: true,
      }),
    );
    expect(changeSenderDecision).not.toHaveBeenCalled();
    expect(batchModify).not.toHaveBeenCalled();
  });

  it("kill switch paused: persists nothing, no Gmail mutation, returns killSwitchPaused=true", async () => {
    getKillSwitchStatus.mockResolvedValueOnce({ paused: true });

    const res = await POST(
      makeRequest({ senderEmail: "x@example.com", action: "delete" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.killSwitchPaused).toBe(true);
    expect(json.retroactiveApplied).toBe(0);
    expect(changeSenderDecision).not.toHaveBeenCalled();
    expect(deleteSenderDecision).not.toHaveBeenCalled();
    expect(batchModify).not.toHaveBeenCalled();
  });

  it("retroactive=false: writes state but skips Gmail mutation", async () => {
    const res = await POST(
      makeRequest({
        senderEmail: "skipme@example.com",
        action: "archive_forever",
        retroactive: false,
      }),
    );
    expect(res.status).toBe(200);

    expect(changeSenderDecision).toHaveBeenCalledTimes(1);
    expect(getMessages).not.toHaveBeenCalled();
    expect(batchModify).not.toHaveBeenCalled();
  });

  it("rejects invalid sender email with 400", async () => {
    const res = await POST(
      makeRequest({ senderEmail: "not-an-email", action: "delete" }),
    );
    expect(res.status).toBe(400);
    expect(changeSenderDecision).not.toHaveBeenCalled();
    expect(deleteSenderDecision).not.toHaveBeenCalled();
  });
});
