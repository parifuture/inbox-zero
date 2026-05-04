import { createScopedLogger, type Logger } from "@/utils/logger";
import { sleep } from "@/utils/sleep";
import { extractErrorInfo, getRetryAfterHeader } from "@/utils/gmail/retry";
import { isFetchError } from "@/utils/retry/is-fetch-error";

/**
 * Structured error taxonomy for Gmail API calls in the autonomous pipeline
 * (EL-356 sender decision gate, EL-357 backlog applier, EL-377).
 *
 * This module is intentionally provider-specific and narrow: it classifies
 * raw googleapis errors into a small set of kinds that drive retry and
 * alerting behavior, and wraps them in a typed `GmailPipelineError` so
 * callers have one catch-shape to match on.
 *
 * Sidecar and non-pipeline code paths (Assistant, Reply Zero, Premium,
 * Newsletter) can opt-in to `runGmailOp` in follow-ups.
 */

const defaultLogger = createScopedLogger("gmail/errors");

export enum GmailErrorKind {
  /** 401 or invalid_grant style — the access token is not usable. */
  AUTH_EXPIRED = "AUTH_EXPIRED",
  /** 429 or 403 rateLimitExceeded / userRateLimitExceeded / quotaExceeded. */
  RATE_LIMITED = "RATE_LIMITED",
  /** 404 — message / thread / label does not exist. */
  NOT_FOUND = "NOT_FOUND",
  /** 400 / 403 non-rate, 400 invalidArgument. */
  INVALID_ARGUMENT = "INVALID_ARGUMENT",
  /** 5xx — transient Gmail server problem. */
  SERVER_ERROR = "SERVER_ERROR",
  /** Fetch / socket / DNS / ECONNRESET / ETIMEDOUT / abort. */
  NETWORK = "NETWORK",
  /** Anything else — we didn't recognise the shape. */
  UNKNOWN = "UNKNOWN",
}

export type GmailOpName =
  | "trash"
  | "untrash"
  | "archive"
  | "modify_labels"
  | "batch_modify_labels"
  | "fetch"
  | "list"
  | "send"
  | "draft"
  | string;

export interface GmailClassification {
  httpMessage?: string;
  kind: GmailErrorKind;
  messageIdContext?: string;
  reason?: string;
  retryAfterMs?: number;
  retryable: boolean;
  status?: number;
}

/**
 * Wrapper around a raw Gmail error so every pipeline call site has a single
 * error shape to match on. The original error is preserved on `.cause` so
 * logging keeps full context.
 */
export class GmailPipelineError extends Error {
  readonly name = "GmailPipelineError";
  readonly kind: GmailErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly op: GmailOpName;
  readonly targetId?: string;
  readonly status?: number;
  readonly reason?: string;

  constructor(
    message: string,
    opts: {
      kind: GmailErrorKind;
      retryable: boolean;
      retryAfterMs?: number;
      op: GmailOpName;
      targetId?: string;
      status?: number;
      reason?: string;
      cause?: unknown;
    },
  ) {
    // Node's Error options include `cause` which logger.error serializes.
    super(
      message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.kind = opts.kind;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
    this.op = opts.op;
    this.targetId = opts.targetId;
    this.status = opts.status;
    this.reason = opts.reason;
  }
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) {
    const delta = asDate.getTime() - Date.now();
    return delta > 0 ? delta : 0;
  }
  return;
}

function isNetworkError(errorMessage: string, code?: string): boolean {
  if (!errorMessage && !code) return false;
  const tokens = [
    "econnreset",
    "etimedout",
    "enotfound",
    "eai_again",
    "econnrefused",
    "epipe",
    "socket hang up",
    "network socket",
    "request timed out",
    "fetch failed",
    "aborterror",
    "aborted",
    "timeout",
  ];
  const haystack = `${errorMessage} ${code ?? ""}`.toLowerCase();
  return tokens.some((t) => haystack.includes(t));
}

/**
 * Map a raw error thrown by googleapis / fetch into a `GmailClassification`.
 *
 * This is the single source of truth for "what kind of Gmail failure was
 * that" — dashboards, retry loops, and alerting all key off the returned
 * `kind`.
 */
export function classifyGmailError(
  err: unknown,
  ctx?: { messageIdContext?: string },
): GmailClassification {
  const info = extractErrorInfo(err);
  const retryAfterMs = parseRetryAfterMs(getRetryAfterHeader(err));
  const base = {
    status: info.status,
    reason: info.reason,
    httpMessage: info.errorMessage,
    messageIdContext: ctx?.messageIdContext,
  };

  // Rate limits first — a 403 can be rate-limit OR invalid_argument.
  const isRate =
    info.status === 429 ||
    info.googleErrorStatus === "RESOURCE_EXHAUSTED" ||
    (info.status === 403 &&
      ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"].includes(
        String(info.reason),
      )) ||
    /rate limit exceeded|user-rate limit exceeded|quota exceeded|resource exhausted|too many concurrent requests/i.test(
      info.errorMessage ?? "",
    );
  if (isRate) {
    return {
      ...base,
      kind: GmailErrorKind.RATE_LIMITED,
      retryable: true,
      retryAfterMs,
    };
  }

  // Auth — 401, or invalid_grant / refresh errors surfaced by googleapis.
  const isAuth =
    info.status === 401 ||
    info.googleErrorStatus === "UNAUTHENTICATED" ||
    /invalid[_\s-]grant|invalid credentials|invalid token|token expired|unauthorized/i.test(
      info.errorMessage ?? "",
    );
  if (isAuth) {
    return { ...base, kind: GmailErrorKind.AUTH_EXPIRED, retryable: false };
  }

  // 404 — target already deleted / doesn't exist. Boring on trash/archive.
  const isNotFound =
    info.status === 404 ||
    info.googleErrorStatus === "NOT_FOUND" ||
    /requested entity was not found|not found/i.test(info.errorMessage ?? "");
  if (isNotFound) {
    return { ...base, kind: GmailErrorKind.NOT_FOUND, retryable: false };
  }

  // Server errors — 5xx, retryable.
  const isServer =
    (typeof info.status === "number" &&
      info.status >= 500 &&
      info.status < 600) ||
    /500|502|503|504|internal error|server error|temporarily unavailable|backenderror/i.test(
      info.errorMessage ?? "",
    );
  if (isServer) {
    return {
      ...base,
      kind: GmailErrorKind.SERVER_ERROR,
      retryable: true,
      retryAfterMs,
    };
  }

  // Network / fetch — retryable.
  const isNet =
    isFetchError({ errorMessage: info.errorMessage ?? "" }) ||
    isNetworkError(info.errorMessage ?? "", info.code);
  if (isNet) {
    return { ...base, kind: GmailErrorKind.NETWORK, retryable: true };
  }

  // 400 / 403 (non-rate) — caller bug, not retryable.
  const isBadRequest =
    info.status === 400 ||
    info.status === 403 ||
    info.googleErrorStatus === "INVALID_ARGUMENT" ||
    info.googleErrorStatus === "PERMISSION_DENIED" ||
    /invalid[_\s-]argument|permission denied|forbidden/i.test(
      info.errorMessage ?? "",
    );
  if (isBadRequest) {
    return { ...base, kind: GmailErrorKind.INVALID_ARGUMENT, retryable: false };
  }

  return { ...base, kind: GmailErrorKind.UNKNOWN, retryable: false };
}

function shortMessage(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}

/** Build a `GmailPipelineError` from a raw thrown value + op context. */
export function wrapGmailError(
  err: unknown,
  opts: { op: GmailOpName; targetId?: string; messageIdContext?: string },
): GmailPipelineError {
  const classification = classifyGmailError(err, {
    messageIdContext: opts.messageIdContext ?? opts.targetId,
  });
  const message = shortMessage(
    classification.httpMessage,
    `${opts.op} failed (${classification.kind})`,
  );
  return new GmailPipelineError(message, {
    kind: classification.kind,
    retryable: classification.retryable,
    retryAfterMs: classification.retryAfterMs,
    op: opts.op,
    targetId: opts.targetId,
    status: classification.status,
    reason: classification.reason,
    cause: err,
  });
}

/** Default retry policy for `runGmailOp`. */
export const DEFAULT_GMAIL_OP_MAX_ATTEMPTS = 3;
/** Cap any single backoff sleep so serverless request budgets aren't blown. */
export const GMAIL_OP_MAX_BACKOFF_MS = 10_000;
/** Minimum backoff cell for exponential attempt spacing. */
export const GMAIL_OP_BASE_BACKOFF_MS = 500;

export interface RunGmailOpOptions {
  /**
   * Downgrade-on-not-found: pipeline callers that trash/archive a message
   * know a 404 means "already gone". Set this to `true` and `runGmailOp`
   * resolves with the provided `notFoundValue` instead of throwing.
   * Default: false.
   */
  downgradeNotFound?: boolean;
  /**
   * Optional logger override. Falls back to the module logger.
   */
  logger?: Logger;
  /**
   * Max attempts including the first call. Defaults to 3.
   * Non-retryable errors break out of the loop immediately.
   */
  maxAttempts?: number;
  /** Value returned when a NOT_FOUND is downgraded. */
  notFoundValue?: unknown;
  /**
   * If provided, invoked once on the first AUTH_EXPIRED failure before
   * retrying. Lets the caller trigger a better-auth token refresh. If the
   * callback itself throws or the retried op still hits AUTH_EXPIRED, the
   * error is re-thrown with the distinct `gmail.auth.expired` log event.
   */
  onAuthExpired?: () => Promise<void> | void;
  /** Short name for the op — used in logs and metrics. */
  op: GmailOpName;
  /** Sleep injection for tests. */
  sleepMs?: (ms: number) => Promise<void>;
  /** The messageId / threadId / sender-email this op targets, if any. */
  targetId?: string;
}

function computeBackoffMs(
  attempt: number,
  classification: GmailClassification,
): number {
  if (
    typeof classification.retryAfterMs === "number" &&
    classification.retryAfterMs > 0
  ) {
    return Math.min(classification.retryAfterMs, GMAIL_OP_MAX_BACKOFF_MS);
  }
  const exp = GMAIL_OP_BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(exp, GMAIL_OP_MAX_BACKOFF_MS);
}

/**
 * Run a single Gmail op with structured classification, retries, and
 * AUTH_EXPIRED refresh-once semantics. Every failure emits a structured
 * `gmail.op.failed` log event that downstream dashboards (EL-369) can read.
 *
 * ```ts
 * await runGmailOp(
 *   () => gmail.users.threads.trash({ userId: "me", id: threadId }),
 *   { op: "trash", targetId: threadId, downgradeNotFound: true, logger },
 * );
 * ```
 */
export async function runGmailOp<T>(
  fn: () => Promise<T>,
  opts: RunGmailOpOptions,
): Promise<T> {
  const logger = opts.logger ?? defaultLogger;
  const maxAttempts = Math.max(
    1,
    opts.maxAttempts ?? DEFAULT_GMAIL_OP_MAX_ATTEMPTS,
  );
  const sleepFn = opts.sleepMs ?? ((ms: number) => sleep(ms));
  let authRefreshTried = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      return await fn();
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const classification = classifyGmailError(err, {
        messageIdContext: opts.targetId,
      });

      // NOT_FOUND downgrade: warn log + no-op return for trash/archive.
      if (
        classification.kind === GmailErrorKind.NOT_FOUND &&
        opts.downgradeNotFound
      ) {
        logger.warn("gmail.op.not_found_downgraded", {
          op: opts.op,
          targetId: opts.targetId,
          attempt,
          durationMs,
          status: classification.status,
          reason: classification.reason,
          message: shortMessage(classification.httpMessage, ""),
        });
        return opts.notFoundValue as T;
      }

      // AUTH_EXPIRED — try one hook-driven refresh, then retry.
      if (
        classification.kind === GmailErrorKind.AUTH_EXPIRED &&
        opts.onAuthExpired &&
        !authRefreshTried &&
        attempt < maxAttempts
      ) {
        authRefreshTried = true;
        logger.warn("gmail.op.auth_refresh_attempt", {
          op: opts.op,
          targetId: opts.targetId,
          attempt,
          durationMs,
        });
        try {
          await opts.onAuthExpired();
        } catch (refreshErr) {
          logger.error("gmail.auth.expired", {
            op: opts.op,
            targetId: opts.targetId,
            attempt,
            durationMs,
            err: refreshErr,
            note: "refresh hook threw",
          });
          throw wrapGmailError(err, {
            op: opts.op,
            targetId: opts.targetId,
          });
        }
        // Fall through to the next attempt without waiting for backoff.
        continue;
      }

      // AUTH_EXPIRED with no hook, or still auth-expired after refresh → terminal.
      if (classification.kind === GmailErrorKind.AUTH_EXPIRED) {
        logger.error("gmail.auth.expired", {
          op: opts.op,
          targetId: opts.targetId,
          attempt,
          durationMs,
          status: classification.status,
          reason: classification.reason,
          message: shortMessage(classification.httpMessage, ""),
        });
        throw wrapGmailError(err, {
          op: opts.op,
          targetId: opts.targetId,
        });
      }

      const canRetry = classification.retryable && attempt < maxAttempts;
      logger.warn("gmail.op.failed", {
        op: opts.op,
        kind: classification.kind,
        retryable: classification.retryable,
        targetId: opts.targetId,
        attempt,
        maxAttempts,
        durationMs,
        status: classification.status,
        reason: classification.reason,
        retryAfterMs: classification.retryAfterMs,
        message: shortMessage(classification.httpMessage, ""),
      });

      if (!canRetry) {
        throw wrapGmailError(err, {
          op: opts.op,
          targetId: opts.targetId,
        });
      }

      const delay = computeBackoffMs(attempt, classification);
      if (delay > 0) await sleepFn(delay);
    }
  }

  // Unreachable — loop either returns or throws — but keeps TS happy.
  throw new GmailPipelineError(`${opts.op} exhausted retries`, {
    kind: GmailErrorKind.UNKNOWN,
    retryable: false,
    op: opts.op,
    targetId: opts.targetId,
  });
}
