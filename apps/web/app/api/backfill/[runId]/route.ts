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

  return {
    run,
    counters: counters.map((c) => ({
      ruleId: c.ruleId,
      action: c.action,
      count: c._count._all,
    })),
    recentDecisions,
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
