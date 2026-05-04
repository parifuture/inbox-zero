import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import { getGmailClientForEmail } from "@/utils/email-account-client";
import {
  createUndoLogger,
  DEFAULT_COUNT,
  findAutoTrashExecutions,
  MAX_COUNT_PER_CALL,
  recordUndoAudit,
  untrashMessages,
  validateFilter,
  type UndoResult,
} from "@/utils/safety/undo-auto-trash";

export type UndoAutoTrashResponse = UndoResult;

const bodySchema = z.object({
  minutes: z.number().int().positive().max(1440).optional(),
  count: z.number().int().positive().max(MAX_COUNT_PER_CALL).optional(),
  senderEmail: z.string().min(3).max(320).optional(),
});

// Per-account rate-limit: one successful undo per 60s. In-memory is fine for
// this single-process fork; if we ever go horizontal move to Redis with a
// SETNX EX guard.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const lastInvocation = new Map<string, number>();

function checkRateLimit(emailAccountId: string):
  | { ok: true }
  | {
      ok: false;
      retryAfterMs: number;
    } {
  const now = Date.now();
  const prev = lastInvocation.get(emailAccountId);
  if (prev && now - prev < RATE_LIMIT_WINDOW_MS) {
    return { ok: false, retryAfterMs: RATE_LIMIT_WINDOW_MS - (now - prev) };
  }
  return { ok: true };
}

function stampRateLimit(emailAccountId: string): void {
  lastInvocation.set(emailAccountId, Date.now());
}

export const POST = withEmailAccount(
  "safety/undo-auto-trash",
  async (request) => {
    const { emailAccountId, userId } = request.auth;
    const logger = createUndoLogger(emailAccountId);

    const raw = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // Fill in default count if neither was supplied \u2014 UI default.
    const filter = {
      minutes: parsed.data.minutes,
      count:
        parsed.data.minutes === undefined && parsed.data.count === undefined
          ? DEFAULT_COUNT
          : parsed.data.count,
      senderEmail: parsed.data.senderEmail,
    };

    const filterErr = validateFilter(filter);
    if (filterErr) {
      return NextResponse.json({ error: filterErr }, { status: 400 });
    }

    const rl = checkRateLimit(emailAccountId);
    if (!rl.ok) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
          retryAfterSeconds: Math.ceil(rl.retryAfterMs / 1000),
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
          },
        },
      );
    }

    logger.warn("safety.undo.started", { operator: userId, filter });

    const executions = await findAutoTrashExecutions({
      emailAccountId,
      filter,
    });

    if (executions.length === 0) {
      stampRateLimit(emailAccountId);
      logger.info("safety.undo.no_matches", { filter });
      return NextResponse.json<UndoAutoTrashResponse>({
        attempted: 0,
        restored: 0,
        notFound: 0,
        failed: 0,
        messageIds: [],
      });
    }

    const gmail = await getGmailClientForEmail({ emailAccountId, logger });
    const messageIds = executions.map((e) => e.messageId);

    let result: UndoResult;
    try {
      result = await untrashMessages({
        messageIds,
        deps: { gmail },
        logger,
      });
    } catch (err) {
      logger.error("safety.undo.failed", { err, filter });
      return NextResponse.json(
        { error: "Untrash call failed. No retry \u2014 see logs." },
        { status: 502 },
      );
    }

    await recordUndoAudit({
      emailAccountId,
      operator: userId,
      filter,
      result,
      executedRuleIds: executions.map((e) => e.id),
      logger,
    });

    stampRateLimit(emailAccountId);

    return NextResponse.json<UndoAutoTrashResponse>(result);
  },
);

export const __test = {
  checkRateLimit,
  stampRateLimit,
  clearRateLimit: () => lastInvocation.clear(),
  RATE_LIMIT_WINDOW_MS,
};
