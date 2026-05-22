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
import { getKillSwitchStatus } from "@/utils/kill-switch";
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

    // EL-482 — kill-switch gate. Refuse to start the executor when
    // autonomous actions are paused; the run stays in
    // awaiting_execution and the user can retry after unpausing.
    const killSwitch = await getKillSwitchStatus(
      request.auth.emailAccountId,
    ).catch(() => ({ paused: false, pauseReason: null }));
    if (killSwitch.paused) {
      logger.warn("backfill.execute.paused", {
        runId: run.id,
        emailAccountId: request.auth.emailAccountId,
        pauseReason: killSwitch.pauseReason ?? null,
      });
      return NextResponse.json(
        {
          error: "Autonomous actions are paused.",
          killSwitchPaused: true,
          pauseReason: killSwitch.pauseReason ?? null,
        },
        { status: 423 },
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
