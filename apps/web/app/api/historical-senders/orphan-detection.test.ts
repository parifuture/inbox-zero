import { describe, it, expect } from "vitest";
import { ORPHAN_SCAN_TIMEOUT_MS, isOrphanedScan } from "./orphan-detection";

describe("historical-senders scan orphan detection (EL-323 blocker)", () => {
  it("is NOT orphaned when status is running and heartbeat is fresh", () => {
    const now = new Date("2026-05-04T13:00:00Z");
    const recent = new Date(now.getTime() - 60_000); // 1 min ago
    expect(
      isOrphanedScan(
        { status: "running", updatedAt: recent, startedAt: recent },
        now,
      ),
    ).toBe(false);
  });

  it("IS orphaned when status is running and heartbeat older than timeout", () => {
    const now = new Date("2026-05-04T13:00:00Z");
    const stale = new Date(now.getTime() - ORPHAN_SCAN_TIMEOUT_MS - 1000);
    expect(
      isOrphanedScan(
        { status: "running", updatedAt: stale, startedAt: stale },
        now,
      ),
    ).toBe(true);
  });

  it("NEVER treats completed/error/idle scans as orphaned", () => {
    const now = new Date("2026-05-04T13:00:00Z");
    const stale = new Date(now.getTime() - ORPHAN_SCAN_TIMEOUT_MS * 10);
    for (const status of ["completed", "error", "idle", "queued"]) {
      expect(
        isOrphanedScan({ status, updatedAt: stale, startedAt: stale }, now),
      ).toBe(false);
    }
  });

  it("falls back to startedAt if updatedAt is null", () => {
    const now = new Date("2026-05-04T13:00:00Z");
    const stale = new Date(now.getTime() - ORPHAN_SCAN_TIMEOUT_MS - 5000);
    expect(
      isOrphanedScan(
        {
          status: "running",
          updatedAt: null,
          startedAt: stale,
        },
        now,
      ),
    ).toBe(true);
  });

  it("treats a running scan with both timestamps null as fresh (unknown heartbeat)", () => {
    // Edge case: a scan row with neither updatedAt nor startedAt should not
    // be marked orphaned \u2014 we'd rather keep the user's view stable than
    // wipe a scan we don't have timing info for.
    const now = new Date("2026-05-04T13:00:00Z");
    expect(
      isOrphanedScan(
        { status: "running", updatedAt: null, startedAt: null },
        now,
      ),
    ).toBe(false);
  });
});
