/**
 * EL-376 — admin parity agreement timeseries.
 *
 * GET /api/admin/parity/timeseries?days=30&emailAccountId=...
 *
 * Returns the per-UTC-day agreement series that powers the dashboard
 * sparkline. Read-only; admin-gated.
 */

import { NextResponse } from "next/server";
import { withAdmin } from "@/utils/middleware";
import { loadParityRows } from "@/utils/parity-classifier/load-parity-rows";
import {
  type DailyAgreementPoint,
  buildDailyAgreementSeries,
} from "@/utils/parity-classifier/timeseries";

export type GetAdminParityTimeseriesResponse = {
  points: DailyAgreementPoint[];
  window: { days: number };
};

function parsePositiveInt(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const GET = withAdmin(
  "admin/parity/timeseries",
  async (request: Request) => {
    const url = new URL(request.url);
    const emailAccountId = url.searchParams.get("emailAccountId") ?? undefined;
    const days = parsePositiveInt(url.searchParams.get("days")) ?? 30;
    const clampedDays = Math.min(days, 90);

    const since = new Date(Date.now() - clampedDays * 24 * 60 * 60 * 1000);

    const rows = await loadParityRows({
      emailAccountId,
      since,
      limit: 200_000,
    });

    const points = buildDailyAgreementSeries(rows, { days: clampedDays });

    return NextResponse.json({
      points,
      window: { days: clampedDays },
    } satisfies GetAdminParityTimeseriesResponse);
  },
);
