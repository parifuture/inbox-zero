/**
 * EL-472 — Backfill API: cooperative stop.
 *
 * POST /api/backfill/[runId]/stop
 *
 * Sets the run status to `stopped`. The worker re-reads status before
 * each sender / each batch and will halt at the next boundary.
 */

import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export const POST = withEmailAccount(
  "backfill/stop",
  async (request, context) => {
    const { runId } = (await context.params) as { runId: string };
    const run = await prisma.backfillRun.findFirst({
      where: { id: runId, emailAccountId: request.auth.emailAccountId },
    });
    if (!run) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Only stop when in a runnable state; "done"/"error"/"stopped" are
    // terminal and shouldn't be transitioned again from the UI.
    const stoppable = new Set([
      "pending",
      "evaluating",
      "awaiting_execution",
      "executing",
    ]);
    if (!stoppable.has(run.status)) {
      return NextResponse.json(
        {
          error: `Run is not stoppable (status=${run.status})`,
        },
        { status: 409 },
      );
    }

    await prisma.backfillRun.update({
      where: { id: run.id },
      data: { status: "stopped", completedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  },
  { requestTiming: {} },
);
