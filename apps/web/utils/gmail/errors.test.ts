import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyGmailError,
  GmailErrorKind,
  GmailPipelineError,
  runGmailOp,
  wrapGmailError,
  DEFAULT_GMAIL_OP_MAX_ATTEMPTS,
} from "./errors";
import { sleep } from "@/utils/sleep";

vi.mock("@/utils/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

function makeGoogleError(opts: {
  status?: number;
  code?: string | number;
  reason?: string;
  message?: string;
  retryAfter?: string;
  googleErrorStatus?: string;
}) {
  const err: Record<string, unknown> = {
    message: opts.message ?? "",
    code: opts.code,
  };
  if (opts.status !== undefined) err.status = opts.status;
  const response: Record<string, unknown> = {
    status: opts.status,
    data: {
      error: {
        code: opts.status,
        status: opts.googleErrorStatus,
        message: opts.message,
        errors: opts.reason
          ? [{ reason: opts.reason, message: opts.message }]
          : undefined,
      },
    },
    headers: opts.retryAfter
      ? {
          "retry-after": opts.retryAfter,
          get: (k: string) =>
            k.toLowerCase() === "retry-after" ? opts.retryAfter : undefined,
        }
      : undefined,
  };
  err.response = response;
  return err;
}

describe("classifyGmailError", () => {
  it("classifies 401 as AUTH_EXPIRED", () => {
    const c = classifyGmailError(
      makeGoogleError({ status: 401, message: "Invalid Credentials" }),
    );
    expect(c.kind).toBe(GmailErrorKind.AUTH_EXPIRED);
    expect(c.retryable).toBe(false);
  });

  it("classifies invalid_grant as AUTH_EXPIRED even without 401", () => {
    const c = classifyGmailError({
      message: "invalid_grant: Token has expired",
    });
    expect(c.kind).toBe(GmailErrorKind.AUTH_EXPIRED);
  });

  it("classifies 403 with rateLimitExceeded as RATE_LIMITED", () => {
    const c = classifyGmailError(
      makeGoogleError({
        status: 403,
        reason: "rateLimitExceeded",
        message: "Rate Limit Exceeded",
      }),
    );
    expect(c.kind).toBe(GmailErrorKind.RATE_LIMITED);
    expect(c.retryable).toBe(true);
  });

  it("classifies plain 403 as INVALID_ARGUMENT", () => {
    const c = classifyGmailError(
      makeGoogleError({ status: 403, message: "Forbidden" }),
    );
    expect(c.kind).toBe(GmailErrorKind.INVALID_ARGUMENT);
    expect(c.retryable).toBe(false);
  });

  it("classifies 404 as NOT_FOUND", () => {
    const c = classifyGmailError(
      makeGoogleError({
        status: 404,
        message: "Requested entity was not found.",
      }),
    );
    expect(c.kind).toBe(GmailErrorKind.NOT_FOUND);
    expect(c.retryable).toBe(false);
  });

  it("classifies 429 with Retry-After header as RATE_LIMITED with retryAfterMs", () => {
    const c = classifyGmailError(
      makeGoogleError({
        status: 429,
        message: "Too Many Requests",
        retryAfter: "7",
      }),
    );
    expect(c.kind).toBe(GmailErrorKind.RATE_LIMITED);
    expect(c.retryable).toBe(true);
    expect(c.retryAfterMs).toBe(7000);
  });

  it("classifies 500 as SERVER_ERROR retryable", () => {
    const c = classifyGmailError(
      makeGoogleError({ status: 500, message: "Internal Error" }),
    );
    expect(c.kind).toBe(GmailErrorKind.SERVER_ERROR);
    expect(c.retryable).toBe(true);
  });

  it("classifies 503 as SERVER_ERROR retryable", () => {
    const c = classifyGmailError(
      makeGoogleError({ status: 503, message: "Service Unavailable" }),
    );
    expect(c.kind).toBe(GmailErrorKind.SERVER_ERROR);
    expect(c.retryable).toBe(true);
  });

  it("classifies timeout messages as NETWORK retryable", () => {
    const c = classifyGmailError({ message: "request timed out" });
    expect(c.kind).toBe(GmailErrorKind.NETWORK);
    expect(c.retryable).toBe(true);
  });

  it("classifies ECONNRESET as NETWORK retryable", () => {
    const c = classifyGmailError({
      code: "ECONNRESET",
      message: "socket hang up",
    });
    expect(c.kind).toBe(GmailErrorKind.NETWORK);
    expect(c.retryable).toBe(true);
  });

  it("classifies fetch failed as NETWORK retryable", () => {
    const c = classifyGmailError({ message: "fetch failed" });
    expect(c.kind).toBe(GmailErrorKind.NETWORK);
    expect(c.retryable).toBe(true);
  });

  it("classifies completely unknown errors as UNKNOWN not retryable", () => {
    const c = classifyGmailError({ message: "something totally weird" });
    expect(c.kind).toBe(GmailErrorKind.UNKNOWN);
    expect(c.retryable).toBe(false);
  });

  it("preserves messageIdContext", () => {
    const c = classifyGmailError(
      { message: "boom" },
      { messageIdContext: "msg123" },
    );
    expect(c.messageIdContext).toBe("msg123");
  });
});

describe("wrapGmailError", () => {
  it("wraps a raw 404 into a GmailPipelineError with NOT_FOUND kind", () => {
    const raw = makeGoogleError({
      status: 404,
      message: "Requested entity was not found.",
    });
    const wrapped = wrapGmailError(raw, { op: "trash", targetId: "t1" });
    expect(wrapped).toBeInstanceOf(GmailPipelineError);
    expect(wrapped.kind).toBe(GmailErrorKind.NOT_FOUND);
    expect(wrapped.op).toBe("trash");
    expect(wrapped.targetId).toBe("t1");
    expect(wrapped.retryable).toBe(false);
  });

  it("sets cause to the original error", () => {
    const raw = new Error("x");
    const wrapped = wrapGmailError(raw, { op: "fetch" });
    expect(wrapped.cause).toBe(raw);
  });
});

describe("runGmailOp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue({ id: "ok" });
    const out = await runGmailOp(fn, { op: "fetch" });
    expect(out).toEqual({ id: "ok" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 then succeeds (integration-style)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        makeGoogleError({
          status: 429,
          message: "rate limit exceeded",
          retryAfter: "1",
        }),
      )
      .mockResolvedValueOnce({ id: "ok" });

    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const out = await runGmailOp(fn, {
      op: "trash",
      targetId: "t1",
      sleepMs: sleepFn,
    });
    expect(out).toEqual({ id: "ok" });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    // retry-after header says 1s
    expect(sleepFn.mock.calls[0][0]).toBe(1000);
  });

  it("retries up to maxAttempts then throws a wrapped error", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(makeGoogleError({ status: 500, message: "boom" }));

    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await expect(
      runGmailOp(fn, { op: "modify_labels", sleepMs: sleepFn, maxAttempts: 3 }),
    ).rejects.toMatchObject({
      name: "GmailPipelineError",
      kind: GmailErrorKind.SERVER_ERROR,
      retryable: true,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(makeGoogleError({ status: 400, message: "bad" }));

    await expect(runGmailOp(fn, { op: "modify_labels" })).rejects.toMatchObject(
      {
        kind: GmailErrorKind.INVALID_ARGUMENT,
      },
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("downgrades NOT_FOUND on trash when downgradeNotFound is set", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        makeGoogleError({ status: 404, message: "not found" }),
      );

    const result = await runGmailOp(fn, {
      op: "trash",
      targetId: "thread1",
      downgradeNotFound: true,
      notFoundValue: { status: 200 },
    });
    expect(result).toEqual({ status: 200 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("invokes onAuthExpired once and retries", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        makeGoogleError({ status: 401, message: "Invalid Credentials" }),
      )
      .mockResolvedValueOnce({ id: "ok" });
    const onAuthExpired = vi.fn().mockResolvedValue(undefined);

    const out = await runGmailOp(fn, {
      op: "fetch",
      onAuthExpired,
      sleepMs: vi.fn().mockResolvedValue(undefined),
    });
    expect(out).toEqual({ id: "ok" });
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws if AUTH_EXPIRED persists after refresh", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        makeGoogleError({ status: 401, message: "Invalid Credentials" }),
      );
    const onAuthExpired = vi.fn().mockResolvedValue(undefined);

    await expect(
      runGmailOp(fn, {
        op: "fetch",
        onAuthExpired,
        sleepMs: vi.fn().mockResolvedValue(undefined),
        maxAttempts: 3,
      }),
    ).rejects.toMatchObject({
      kind: GmailErrorKind.AUTH_EXPIRED,
      retryable: false,
    });
    // refresh hook only called once
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
  });

  it("throws AUTH_EXPIRED immediately when no refresh hook is provided", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        makeGoogleError({ status: 401, message: "Invalid Credentials" }),
      );

    await expect(runGmailOp(fn, { op: "fetch" })).rejects.toMatchObject({
      kind: GmailErrorKind.AUTH_EXPIRED,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses default max attempts = 3", () => {
    expect(DEFAULT_GMAIL_OP_MAX_ATTEMPTS).toBe(3);
  });

  it("sleep is injectable; real sleep is not hit in tests", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeGoogleError({ status: 500, message: "boom" }))
      .mockResolvedValueOnce({ ok: true });
    const customSleep = vi.fn().mockResolvedValue(undefined);
    await runGmailOp(fn, { op: "fetch", sleepMs: customSleep });
    expect(customSleep).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
