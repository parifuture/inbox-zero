/**
 * EL-472 — Backfill API: kick off Gmail execution for a run.
 *
 * POST /api/backfill/[runId]/execute
 *
 * The run must be in `awaiting_execution` (the dry-run safety gate).
 * Returns immediately; the actual Gmail writes happen in the
 * background and progress is polled via /api/backfill/[runId].
 */

import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { executeRun } from "@/utils/backfill/worker";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("api/backfill/execute");

export const POST = withEmailAccount(
  "backfill/execute",
  async (request, context) => {
    const { runId } = (await context.params) as { runId: string };
    const run = await prisma.backfillRun.findFirst({
      where: { id: runId, emailAccountId: request.auth.emailAccountId },
    });
    if (!run) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (run.status !== "awaiting_execution") {
      return NextResponse.json(
        {
          error: `Run is not awaiting execution (status=${run.status})`,
        },
        { status: 409 },
      );
    }

    setImmediate(() => {
      executeRun(run.id).catch((err) => {
        logger.error("executeRun failed", { runId: run.id, error: err });
      });
    });

    return NextResponse.json({ ok: true, runId: run.id });
  },
  { requestTiming: {} },
);
