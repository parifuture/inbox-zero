/**
 * EL-376 — 30-day daily agreement timeseries for the parity dashboard sparkline.
 *
 * Pure reducer: takes `ParityDecision`-shaped rows and bucketises them into a
 * per-UTC-day {compared, agreed, agreementRate} series. Gaps are filled with
 * zeroed buckets so the sparkline renders a contiguous line even when no
 * activity landed on a given day.
 */

import type { ParityRow } from "./metrics";

export interface DailyAgreementPoint {
  agreed: number;
  /** 0..1, null when compared === 0. */
  agreementRate: number | null;
  compared: number;
  /** ISO date (YYYY-MM-DD) in UTC. */
  day: string;
  total: number;
}

export interface BuildDailySeriesOptions {
  /** Number of days in the window (default: 30). */
  days?: number;
  /** Inclusive end day (default: today in UTC). */
  end?: Date;
}

function toUtcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysUtc(d: Date, n: number): Date {
  const copy = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

export function buildDailyAgreementSeries(
  rows: Pick<ParityRow, "action" | "sidecarAction" | "createdAt">[],
  opts: BuildDailySeriesOptions = {},
): DailyAgreementPoint[] {
  const days = opts.days ?? 30;
  const end = opts.end
    ? new Date(
        Date.UTC(
          opts.end.getUTCFullYear(),
          opts.end.getUTCMonth(),
          opts.end.getUTCDate(),
        ),
      )
    : (() => {
        const now = new Date();
        return new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
      })();

  // Prime the full window with empty buckets so the sparkline has a fixed
  // width regardless of sparsity.
  const buckets = new Map<
    string,
    { total: number; compared: number; agreed: number }
  >();
  for (let i = days - 1; i >= 0; i--) {
    buckets.set(toUtcDayKey(addDaysUtc(end, -i)), {
      total: 0,
      compared: 0,
      agreed: 0,
    });
  }

  for (const row of rows) {
    if (!row.createdAt) continue;
    const key = toUtcDayKey(row.createdAt);
    const bucket = buckets.get(key);
    if (!bucket) continue; // outside window
    bucket.total += 1;
    if (row.sidecarAction != null) {
      bucket.compared += 1;
      if (row.action === row.sidecarAction) bucket.agreed += 1;
    }
  }

  return [...buckets.entries()].map(([day, b]) => ({
    day,
    total: b.total,
    compared: b.compared,
    agreed: b.agreed,
    agreementRate: b.compared === 0 ? null : b.agreed / b.compared,
  }));
}
