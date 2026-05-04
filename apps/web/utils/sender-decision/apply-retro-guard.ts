import type { gmail_v1 } from "@googleapis/gmail";
import { env } from "@/env";
import { runGmailOp } from "@/utils/gmail/errors";
import { withGmailRetry } from "@/utils/gmail/retry";
import type { Logger } from "@/utils/logger";
import {
  buildApplierPlan,
  type ApplierAction,
} from "@/utils/sender-decision/backlog-applier";

const MODULE = "sender-decision.apply-retro-guard";

/** Default blast-radius thresholds. Can be overridden by env. */
export const DEFAULT_APPLY_RETRO_SOFT_CAP = 200;
export const DEFAULT_APPLY_RETRO_HARD_CAP = 2000;

/**
 * Absolute preview ceiling. The preview pager walks Gmail until either it
 * exhausts the query or it reaches `hardCap + 1` ids, at which point it
 * reports `overHardCap=true` and stops. We never walk all 10k+ messages just
 * to get a precise count for rejection \u2014 over-cap is enough to decide.
 */
export function getConfiguredThresholds(): {
  softCap: number;
  hardCap: number;
} {
  const softCap = env.APPLY_RETRO_SOFT_CAP ?? DEFAULT_APPLY_RETRO_SOFT_CAP;
  const hardCap = env.APPLY_RETRO_HARD_CAP ?? DEFAULT_APPLY_RETRO_HARD_CAP;
  return { softCap, hardCap };
}

export type PreviewResult = {
  /** Message count matching the applier query. Capped at `hardCap + 1` when `overHardCap`. */
  count: number;
  /** True when the preview hit the hard-cap ceiling and stopped early. */
  overHardCap: boolean;
  /** Gmail search query used for the preview. Useful for logging / tests. */
  query: string;
};

export type PreviewDeps = {
  gmail: gmail_v1.Gmail;
  /** Override pager for tests. */
  listMessageIds?: (
    query: string,
    stopAt: number,
  ) => Promise<{ count: number; overHardCap: boolean }>;
};

async function previewListIds(
  gmail: gmail_v1.Gmail,
  query: string,
  stopAt: number,
  logger: Logger,
): Promise<{ count: number; overHardCap: boolean }> {
  let count = 0;
  let pageToken: string | undefined;

  do {
    const resp = await runGmailOp(
      () =>
        withGmailRetry(() =>
          gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: 500,
            pageToken,
            // We only need ids to count; the API returns ids by default.
          }),
        ),
      { op: "list", targetId: `preview:${query}`, logger },
    );

    count += (resp.data.messages ?? []).length;
    pageToken = resp.data.nextPageToken ?? undefined;

    if (count > stopAt) {
      return { count: stopAt + 1, overHardCap: true };
    }
  } while (pageToken);

  return { count, overHardCap: false };
}

/**
 * Count the messages an apply-retro run would touch. Returns no later than
 * `hardCap + 1` ids \u2014 anything beyond that is treated as "over hard cap"
 * and the run is rejected outright (operator override required).
 */
export async function previewApplierBlastRadius(params: {
  senderEmail: string;
  action: ApplierAction;
  hardCap: number;
  logger: Logger;
  deps: PreviewDeps;
}): Promise<PreviewResult> {
  const { senderEmail, action, hardCap, logger, deps } = params;
  const { query } = buildApplierPlan(senderEmail, action);

  const result = deps.listMessageIds
    ? await deps.listMessageIds(query, hardCap)
    : await previewListIds(deps.gmail, query, hardCap, logger);

  logger.info("sender_decision.apply_retro.preview", {
    senderEmail,
    action,
    count: result.count,
    overHardCap: result.overHardCap,
    hardCap,
    module: MODULE,
  });

  return { query, count: result.count, overHardCap: result.overHardCap };
}

export type ApplyRetroDecisionInput = {
  preview: PreviewResult;
  softCap: number;
  hardCap: number;
  /** Caller-supplied confirmation block from request body. */
  body: {
    confirm?: unknown;
    expectedCount?: unknown;
    override?: unknown;
  };
};

export type ApplyRetroDecision =
  | { ok: true; requiresOverrideLog: boolean }
  | {
      ok: false;
      status: 400 | 409;
      code:
        | "confirmation_required"
        | "hard_cap_exceeded"
        | "expected_count_mismatch";
      message: string;
    };

/**
 * Pure policy: given a preview + request body, decide whether the apply-retro
 * run is allowed to proceed. No IO \u2014 trivial to unit-test.
 */
export function evaluateApplyRetroGuard(
  input: ApplyRetroDecisionInput,
): ApplyRetroDecision {
  const { preview, softCap, hardCap, body } = input;
  const confirm = body.confirm === true;
  const override = body.override === true;
  const expectedCount =
    typeof body.expectedCount === "number" ? body.expectedCount : null;

  // Hard cap: even with confirm, require explicit operator override.
  if (preview.overHardCap || preview.count > hardCap) {
    if (!(confirm && override)) {
      return {
        ok: false,
        status: 400,
        code: "hard_cap_exceeded",
        message: `Matches exceed hard cap (${hardCap}). Set { confirm: true, override: true } to proceed.`,
      };
    }
    return { ok: true, requiresOverrideLog: true };
  }

  // Under soft cap \u2014 auto-run, no confirmation needed.
  if (preview.count <= softCap) {
    return { ok: true, requiresOverrideLog: false };
  }

  // Soft cap exceeded: require confirm + matching expectedCount.
  if (!confirm) {
    return {
      ok: false,
      status: 409,
      code: "confirmation_required",
      message: `Preview matched ${preview.count} messages (over soft cap ${softCap}). Retry with { confirm: true, expectedCount: ${preview.count} }.`,
    };
  }

  if (expectedCount !== preview.count) {
    return {
      ok: false,
      status: 409,
      code: "expected_count_mismatch",
      message: `expectedCount did not match preview (${preview.count}). Refresh and retry.`,
    };
  }

  return { ok: true, requiresOverrideLog: false };
}
