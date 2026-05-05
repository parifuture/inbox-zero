/**
 * EL-363 — admin parity metrics endpoint.
 *
 * GET /api/admin/parity/metrics?emailAccountId=...&days=7
 *
 * Returns an `AgreementStats` payload suitable for the EL-376 dashboard.
 * Server-only: gated behind the admin middleware.
 */

import { NextResponse } from "next/server";
import { withAdmin } from "@/utils/middleware";
import { loadParityRows } from "@/utils/parity-classifier/load-parity-rows";
import {
  type AgreementStats,
  buildAgreementLogPayload,
  computeAgreementStats,
} from "@/utils/parity-classifier/metrics";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("parity-metrics");

export type GetAdminParityMetricsResponse = {
  stats: AgreementStats;
  window: { since: string | null; until: string | null };
};

function parsePositiveInt(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const GET = withAdmin(
  "admin/parity/metrics",
  async (request: Request) => {
    const url = new URL(request.url);
    const emailAccountId = url.searchParams.get("emailAccountId") ?? undefined;
    const days = parsePositiveInt(url.searchParams.get("days"));
    const limit = parsePositiveInt(url.searchParams.get("limit")) ?? 50_000;

    const now = new Date();
    const since = days
      ? new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
      : undefined;

    const rows = await loadParityRows({
      emailAccountId,
      since,
      limit,
    });

    const stats = computeAgreementStats(rows);

    // Emit the structured log every call so a simple `watch this route` cron
    // doubles as the EL-363 observability hook.
    logger.info("parity agreement computed", {
      ...buildAgreementLogPayload(stats),
      email_account_id: emailAccountId ?? null,
      window_days: days ?? null,
    });

    return NextResponse.json({
      stats,
      window: {
        since: since ? since.toISOString() : null,
        until: now.toISOString(),
      },
    } satisfies GetAdminParityMetricsResponse);
  },
);
