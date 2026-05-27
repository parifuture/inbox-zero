/**
 * EL-472 — Backfill API: single run state for live UI polling.
 *
 * GET /api/backfill/[runId]
 * Returns the BackfillRun row plus aggregated decision counters for
 * the live progress UI. Polled at ~2s intervals via SWR.
 */

import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export type BackfillRunDetailResponse = Awaited<
  ReturnType<typeof getRunDetail>
>;

async function getRunDetail({
  runId,
  emailAccountId,
}: {
  runId: string;
  emailAccountId: string;
}) {
  const run = await prisma.backfillRun.findFirst({
    where: { id: runId, emailAccountId },
  });
  if (!run) return null;

  // Per-rule + per-action counters in a single GROUP BY. Drives the
  // live "rules and what they did" table on the UI.
  const counters = await prisma.backfillDecision.groupBy({
    by: ["ruleId", "action"],
    where: { runId: run.id },
    _count: { _all: true },
  });

  // Tail of the most recent ~20 decisions for the activity log.
  const recentDecisions = await prisma.backfillDecision.findMany({
    where: { runId: run.id },
    orderBy: { decidedAt: "desc" },
    take: 20,
    select: {
      id: true,
      messageId: true,
      sender: true,
      ruleId: true,
      action: true,
      labelName: true,
      reason: true,
      confidence: true,
      decidedAt: true,
      executedAt: true,
      executionError: true,
    },
  });

  // EL-506 — resolve rule UUIDs to names for the UI. We look up the
  // union of (run.ruleIds, decision.ruleIds) so that even rules that
  // were deleted or removed from the run between creation and now
  // still surface a name when they appear in the decisions table.
  // Single findMany — no N+1.
  const decisionRuleIds = new Set<string>();
  for (const c of counters) {
    if (c.ruleId) decisionRuleIds.add(c.ruleId);
  }
  for (const d of recentDecisions) {
    if (d.ruleId) decisionRuleIds.add(d.ruleId);
  }
  const ruleIdsToFetch = Array.from(
    new Set<string>([...run.ruleIds, ...decisionRuleIds]),
  );
  const rules = ruleIdsToFetch.length
    ? await prisma.rule.findMany({
        where: { id: { in: ruleIdsToFetch }, emailAccountId },
        select: { id: true, name: true },
      })
    : [];

  return {
    run,
    counters: counters.map((c) => ({
      ruleId: c.ruleId,
      action: c.action,
      count: c._count._all,
    })),
    recentDecisions,
    rules,
  };
}

export const GET = withEmailAccount(
  "backfill/detail",
  async (request, context) => {
    const { runId } = (await context.params) as { runId: string };
    const result = await getRunDetail({
      runId,
      emailAccountId: request.auth.emailAccountId,
    });
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  },
  { requestTiming: {} },
);
