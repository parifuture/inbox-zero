import { describe, expect, it } from "vitest";
import { buildDailyAgreementSeries } from "./timeseries";

const d = (iso: string): Date => new Date(iso);

describe("buildDailyAgreementSeries", () => {
  it("returns the requested window length with zeroed empty buckets", () => {
    const series = buildDailyAgreementSeries([], {
      end: d("2025-02-01T12:34:56Z"),
      days: 7,
    });
    expect(series).toHaveLength(7);
    expect(series[0].day).toBe("2025-01-26");
    expect(series[6].day).toBe("2025-02-01");
    for (const pt of series) {
      expect(pt.total).toBe(0);
      expect(pt.compared).toBe(0);
      expect(pt.agreed).toBe(0);
      expect(pt.agreementRate).toBeNull();
    }
  });

  it("buckets rows by UTC day and computes per-day agreement", () => {
    const series = buildDailyAgreementSeries(
      [
        // 2025-01-31: 2 agreed, 1 disagreed, 1 uncompared
        {
          action: "trash",
          sidecarAction: "trash",
          createdAt: d("2025-01-31T00:00:00Z"),
        },
        {
          action: "inbox",
          sidecarAction: "inbox",
          createdAt: d("2025-01-31T23:59:00Z"),
        },
        {
          action: "trash",
          sidecarAction: "inbox",
          createdAt: d("2025-01-31T10:00:00Z"),
        },
        {
          action: "inbox",
          sidecarAction: null,
          createdAt: d("2025-01-31T09:00:00Z"),
        },
        // 2025-02-01: 1 agreed
        {
          action: "inbox",
          sidecarAction: "inbox",
          createdAt: d("2025-02-01T05:00:00Z"),
        },
        // outside window
        {
          action: "inbox",
          sidecarAction: "inbox",
          createdAt: d("2024-12-01T00:00:00Z"),
        },
      ],
      { end: d("2025-02-01T23:59:00Z"), days: 3 },
    );

    expect(series.map((p) => p.day)).toEqual([
      "2025-01-30",
      "2025-01-31",
      "2025-02-01",
    ]);
    expect(series[0]).toMatchObject({ total: 0, compared: 0, agreed: 0 });
    expect(series[1]).toMatchObject({ total: 4, compared: 3, agreed: 2 });
    expect(series[1].agreementRate).toBeCloseTo(2 / 3, 5);
    expect(series[2]).toMatchObject({
      total: 1,
      compared: 1,
      agreed: 1,
      agreementRate: 1,
    });
  });

  it("skips rows with no createdAt", () => {
    const series = buildDailyAgreementSeries(
      [
        { action: "inbox", sidecarAction: "inbox" },
        {
          action: "inbox",
          sidecarAction: "inbox",
          createdAt: d("2025-02-01T00:00:00Z"),
        },
      ],
      { end: d("2025-02-01T00:00:00Z"), days: 1 },
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ total: 1, compared: 1, agreed: 1 });
  });
});
