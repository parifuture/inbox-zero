import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractErrorInfo,
  isRetryableError,
  calculateRetryDelay,
  withGmailRetry,
  MAX_GMAIL_BLOCKING_RETRY_DELAY_MS,
} from "./retry";
import { sleep } from "@/utils/sleep";

vi.mock("@/utils/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

describe("Gmail retry helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isRetryableError", () => {
    it("should identify 502 status code as retryable server error", () => {
      const errorInfo = { status: 502, errorMessage: "Server Error" };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(true);
      expect(result.isServerError).toBe(true);
      expect(result.isRateLimit).toBe(false);
    });

    it("should identify 502 in error message as retryable (Gmail HTML error)", () => {
      const errorInfo = {
        errorMessage: "Error 502 (Server Error)!!1",
      };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(true);
      expect(result.isServerError).toBe(true);
      expect(result.isRateLimit).toBe(false);
    });

    it("should identify 503 in error message as retryable", () => {
      const errorInfo = {
        errorMessage: "503 Service Unavailable",
      };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(true);
      expect(result.isServerError).toBe(true);
      expect(result.isRateLimit).toBe(false);
    });

    it("should identify 504 Gateway Timeout as retryable", () => {
      const errorInfo = { status: 504, errorMessage: "Gateway Timeout" };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(true);
      expect(result.isServerError).toBe(true);
      expect(result.isRateLimit).toBe(false);
    });

    it("should identify 429 as a retryable rate limit error", () => {
      const errorInfo = { status: 429, errorMessage: "Too Many Requests" };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(true);
      expect(result.isRateLimit).toBe(true);
      expect(result.isServerError).toBe(false);
    });

    it("should identify 403 with rateLimitExceeded reason as retryable", () => {
      const errorInfo = {
        status: 403,
        reason: "rateLimitExceeded",
        errorMessage: "Rate limit exceeded",
      };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(true);
      expect(result.isRateLimit).toBe(true);
      expect(result.isServerError).toBe(false);
    });

    it("should identify RESOURCE_EXHAUSTED concurrent request errors as retryable", () => {
      const errorInfo = {
        googleErrorStatus: "RESOURCE_EXHAUSTED",
        errorMessage: "Too many concurrent requests for user",
      };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(true);
      expect(result.isRateLimit).toBe(true);
      expect(result.isServerError).toBe(false);
    });

    it("should identify fetch failed as network error", () => {
      const errorInfo = { errorMessage: "fetch failed" };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(true);
      expect(result.isRateLimit).toBe(false);
      expect(result.isServerError).toBe(false);
      expect(result.isFailedPrecondition).toBe(false);
    });

    it("should identify 404 as non-retryable", () => {
      const errorInfo = { status: 404, errorMessage: "Not Found" };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(false);
      expect(result.isRateLimit).toBe(false);
      expect(result.isServerError).toBe(false);
      expect(result.isFailedPrecondition).toBe(false);
    });

    it("should identify 403 without rate limit reason as non-retryable", () => {
      const errorInfo = {
        status: 403,
        reason: "forbidden",
        errorMessage: "Forbidden",
      };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(false);
      expect(result.isRateLimit).toBe(false);
      expect(result.isServerError).toBe(false);
      expect(result.isFailedPrecondition).toBe(false);
    });

    it("should identify failedPrecondition as retryable", () => {
      const errorInfo = {
        status: 400,
        reason: "failedPrecondition",
        errorMessage: "Precondition check failed.",
      };
      const result = isRetryableError(errorInfo);

      expect(result.retryable).toBe(true);
      expect(result.isRateLimit).toBe(false);
      expect(result.isServerError).toBe(false);
      expect(result.isFailedPrecondition).toBe(true);
    });
  });

  describe("calculateRetryDelay", () => {
    // Jitter adds ±25%. Helper to assert base-relative bounds.
    const expectJittered = (delay: number, base: number) => {
      const low = Math.floor(base * 0.75);
      const high = Math.ceil(base * 1.25);
      expect(delay).toBeGreaterThanOrEqual(low);
      expect(delay).toBeLessThanOrEqual(high);
    };

    it("should use short exponential backoff for rate limit errors", () => {
      expectJittered(calculateRetryDelay(true, false, false, 1), 1000);
      expectJittered(calculateRetryDelay(true, false, false, 2), 2000);
      expectJittered(calculateRetryDelay(true, false, false, 4), 8000);
      expectJittered(calculateRetryDelay(true, false, false, 5), 10_000);
    });

    it("should use exponential backoff for server errors", () => {
      expectJittered(calculateRetryDelay(false, true, false, 1), 5000);
      expectJittered(calculateRetryDelay(false, true, false, 2), 10_000);
      expectJittered(calculateRetryDelay(false, true, false, 3), 20_000);
    });

    it("should use fallback delay when retry time is in the past", () => {
      const pastDate = new Date(Date.now() - 10_000).toISOString();
      const errorMessage = `Rate limit exceeded. Retry after ${pastDate}`;

      // Should fall back to rate-limit backoff (jittered)
      const delay = calculateRetryDelay(
        true,
        false,
        false,
        1,
        undefined,
        errorMessage,
      );
      expectJittered(delay, 1000);
    });

    it("should use fallback delay when Retry-After header is stale", () => {
      // Use HTTP-date format (like "Wed, 21 Oct 2015 07:28:00 GMT")
      const pastDate = new Date(Date.now() - 5000).toUTCString();

      // Should fall back to exponential backoff for server error (jittered)
      const delay = calculateRetryDelay(false, true, false, 2, pastDate);
      expectJittered(delay, 10_000);
    });

    it("should use retry time from error message when valid (NO jitter — server-provided)", () => {
      const futureDate = new Date(Date.now() + 15_000).toISOString();
      const errorMessage = `Rate limit exceeded. Retry after ${futureDate}`;

      const delay = calculateRetryDelay(
        true,
        false,
        false,
        1,
        undefined,
        errorMessage,
      );
      expect(delay).toBeGreaterThan(14_000); // Should be ~15s
      expect(delay).toBeLessThan(16_000);
    });

    it("should use short backoff for failed precondition", () => {
      expectJittered(calculateRetryDelay(false, false, true, 1), 1000);
      expectJittered(calculateRetryDelay(false, false, true, 3), 4000);
      expectJittered(calculateRetryDelay(false, false, true, 5), 10_000);
    });

    it("should use default exponential backoff for other retryable errors (e.g., network)", () => {
      expectJittered(calculateRetryDelay(false, false, false, 1), 1000);
      expectJittered(calculateRetryDelay(false, false, false, 2), 2000);
      expectJittered(calculateRetryDelay(false, false, false, 3), 4000);
      expectJittered(calculateRetryDelay(false, false, false, 4), 8000);
      expectJittered(calculateRetryDelay(false, false, false, 5), 16_000);
      expectJittered(calculateRetryDelay(false, false, false, 6), 16_000);
    });

    it("jitter spreads consecutive calls around the base but never exceeds ±25%", () => {
      const samples = Array.from({ length: 200 }, () =>
        calculateRetryDelay(true, false, false, 3),
      );
      // base 4000ms, jitter ±25% → [3000, 5000]
      for (const delay of samples) {
        expect(delay).toBeGreaterThanOrEqual(3000);
        expect(delay).toBeLessThanOrEqual(5000);
      }
      // Should actually spread (reject the "always returns base" bug)
      const unique = new Set(samples);
      expect(unique.size).toBeGreaterThan(10);
    });
  });

  describe("extractErrorInfo", () => {
    it("should extract Gmail error details from response payload", () => {
      const error = {
        cause: {
          response: {
            status: 404,
            data: {
              error: {
                message: "Invalid label: FAKE_LABEL_ID_123",
                errors: [{ reason: "notFound" }],
              },
            },
          },
        },
      };

      const info = extractErrorInfo(error);

      expect(info.status).toBe(404);
      expect(info.reason).toBe("notFound");
      expect(info.errorMessage).toBe("Invalid label: FAKE_LABEL_ID_123");
    });

    it("should extract numeric status from RESOURCE_EXHAUSTED payloads", () => {
      const error = {
        cause: {
          response: {
            data: {
              error: {
                code: "429",
                status: "RESOURCE_EXHAUSTED",
                message: "Too many concurrent requests for user",
              },
            },
          },
        },
      };

      const info = extractErrorInfo(error);

      expect(info.status).toBe(429);
      expect(info.code).toBe("429");
      expect(info.googleErrorStatus).toBe("RESOURCE_EXHAUSTED");
      expect(info.errorMessage).toBe("Too many concurrent requests for user");
    });

    it("should fall back to top-level error string when message missing", () => {
      const error = {
        error: "Some top-level error",
      };

      const info = extractErrorInfo(error);

      expect(info.status).toBeUndefined();
      expect(info.reason).toBeUndefined();
      expect(info.errorMessage).toBe("Some top-level error");
    });
  });

  describe("withGmailRetry", () => {
    it("aborts retry loop when backoff exceeds serverless cap", async () => {
      const retryAt = new Date(
        Date.now() + MAX_GMAIL_BLOCKING_RETRY_DELAY_MS + 60_000,
      ).toISOString();
      const error = Object.assign(
        new Error(`User-rate limit exceeded. Retry after ${retryAt}`),
        {
          cause: {
            status: 429,
            message: `User-rate limit exceeded. Retry after ${retryAt}`,
          },
        },
      );
      const operation = vi.fn().mockRejectedValue(error);

      await expect(withGmailRetry(operation, 5)).rejects.toBe(error);

      expect(operation).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("rethrows original non-retryable errors", async () => {
      const error = Object.assign(new Error("Not Found"), { status: 404 });
      const operation = vi.fn().mockRejectedValue(error);

      await expect(withGmailRetry(operation, 5)).rejects.toBe(error);

      expect(operation).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});
