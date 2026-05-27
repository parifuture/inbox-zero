/**
 * EL-506 — regression: GET /api/backfill/[runId] resolves rule UUIDs
 * to names so the UI can render human-readable per-rule activity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");

vi.mock("@/utils/middleware", () => ({
  withEmailAccount:
    (
      _scope: string,
      handler: (
        request: Request & { auth: { emailAccountId: string } },
        context: { params: Promise<{ runId: string }> },
      ) => Promise<Response>,
    ) =>
    async (request: Request, context: { params: Promise<{ runId: string }> }) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "ea-1" },
        }),
        context,
      ),
}));

import { GET } from "./route";

describe("GET /api/backfill/[runId] — EL-506 rule-name resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns rules array with names for run.ruleIds and decision.ruleIds", async () => {
    prisma.backfillRun.findFirst.mockResolvedValue({
      id: "run-1",
      emailAccountId: "ea-1",
      ruleIds: ["rule-a", "rule-b"],
      status: "done",
      // padding fields not asserted by the test
    } as never);

    prisma.backfillDecision.groupBy.mockResolvedValue([
      { ruleId: "rule-a", action: "ARCHIVE", _count: { _all: 5 } } as never,
      { ruleId: "rule-c", action: "TRASH", _count: { _all: 2 } } as never,
      { ruleId: null, action: "SKIP", _count: { _all: 1 } } as never,
    ]);

    prisma.backfillDecision.findMany.mockResolvedValue([
      { id: "d1", ruleId: "rule-a", action: "ARCHIVE" } as never,
      { id: "d2", ruleId: "rule-c", action: "TRASH" } as never,
    ]);

    // rule-c was orphaned (e.g. the user removed it from the run config
    // mid-flight, or deleted it). We still want a name when it appears
    // in the decisions log — but if the row no longer exists we should
    // not crash, just leave it absent from the result and let the UI
    // render a (deleted rule …) fallback.
    prisma.rule.findMany.mockResolvedValue([
      { id: "rule-a", name: "Newsletter cleanup" } as never,
      { id: "rule-b", name: "Receipts to label" } as never,
      // rule-c missing on purpose — simulates deletion
    ]);

    const req = new NextRequest("https://example.com/api/backfill/run-1");
    const res = await GET(
      req as never,
      {
        params: Promise.resolve({ runId: "run-1" }),
      } as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.rules)).toBe(true);
    // Both run-attached rules + rule-c (referenced by counters/decisions)
    // should be in the lookup set.
    const queriedIds = (
      prisma.rule.findMany.mock.calls[0][0] as {
        where: { id: { in: string[] } };
      }
    ).where.id.in.sort();
    expect(queriedIds).toEqual(["rule-a", "rule-b", "rule-c"]);
    expect(
      (
        prisma.rule.findMany.mock.calls[0][0] as {
          where: { emailAccountId: string };
        }
      ).where.emailAccountId,
    ).toBe("ea-1");

    const names = new Map(
      (body.rules as Array<{ id: string; name: string }>).map((r) => [
        r.id,
        r.name,
      ]),
    );
    expect(names.get("rule-a")).toBe("Newsletter cleanup");
    expect(names.get("rule-b")).toBe("Receipts to label");
    // rule-c absent — UI handles via fallback
    expect(names.has("rule-c")).toBe(false);

    // Existing fields still present
    expect(body.run.id).toBe("run-1");
    expect(body.counters).toHaveLength(3);
    expect(body.recentDecisions).toHaveLength(2);
  });

  it("returns rules: [] when there are no decisions and run has no ruleIds", async () => {
    prisma.backfillRun.findFirst.mockResolvedValue({
      id: "run-2",
      emailAccountId: "ea-1",
      ruleIds: [],
      status: "pending",
    } as never);
    prisma.backfillDecision.groupBy.mockResolvedValue([]);
    prisma.backfillDecision.findMany.mockResolvedValue([]);

    const req = new NextRequest("https://example.com/api/backfill/run-2");
    const res = await GET(
      req as never,
      {
        params: Promise.resolve({ runId: "run-2" }),
      } as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules).toEqual([]);
    // Rule lookup should be skipped entirely when there's nothing to fetch
    expect(prisma.rule.findMany).not.toHaveBeenCalled();
  });

  it("404s when the run isn't found for this email account", async () => {
    prisma.backfillRun.findFirst.mockResolvedValue(null);
    const req = new NextRequest("https://example.com/api/backfill/missing");
    const res = await GET(
      req as never,
      {
        params: Promise.resolve({ runId: "missing" }),
      } as never,
    );
    expect(res.status).toBe(404);
  });
});
