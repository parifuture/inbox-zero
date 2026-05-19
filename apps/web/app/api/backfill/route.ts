/**
 * EL-472 — Backfill API: list runs + create new run.
 *
 * GET  /api/backfill         List recent runs for this email account.
 * POST /api/backfill         Create a new run + kick off evaluation in
 *                            the background (fire-and-forget — the
 *                            worker is idempotent and resumable, so
 *                            a process death means a retry, not loss).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { evaluateRun } from "@/utils/backfill/worker";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("api/backfill");

export type BackfillRunListResponse = Awaited<ReturnType<typeof listRuns>>;

async function listRuns({ emailAccountId }: { emailAccountId: string }) {
  return prisma.backfillRun.findMany({
    where: { emailAccountId },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
}

const createBackfillBody = z.object({
  ruleIds: z.array(z.string()).min(1),
  dateFloor: z.string().datetime().nullable().optional(),
  senderScope: z.string().email().nullable().optional(),
  modelId: z.string().default("us.anthropic.claude-sonnet-4-7"),
  // Phase 1 forces dryRun=true regardless of the client value. We
  // accept the field for forward-compat (Phase 2 auto-execute) but
  // ignore it here.
  dryRun: z.boolean().optional(),
});

export const GET = withEmailAccount(
  "backfill/list",
  async (request) => {
    const runs = await listRuns({
      emailAccountId: request.auth.emailAccountId,
    });
    return NextResponse.json(runs);
  },
  { requestTiming: {} },
);

export const POST = withEmailAccount(
  "backfill/create",
  async (request) => {
    const body = await request.json();
    const parsed = createBackfillBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const emailAccountId = request.auth.emailAccountId;

    // Sanity: every ruleId actually belongs to this email account so
    // a malicious client can't reference another user's rule.
    const rules = await prisma.rule.findMany({
      where: { id: { in: parsed.data.ruleIds }, emailAccountId },
      select: { id: true },
    });
    if (rules.length !== parsed.data.ruleIds.length) {
      return NextResponse.json(
        { error: "One or more rules do not belong to this account" },
        { status: 403 },
      );
    }

    const run = await prisma.backfillRun.create({
      data: {
        emailAccountId,
        ruleIds: parsed.data.ruleIds,
        dateFloor: parsed.data.dateFloor
          ? new Date(parsed.data.dateFloor)
          : null,
        senderScope: parsed.data.senderScope ?? null,
        modelId: parsed.data.modelId,
        // Phase 1 mandatory dry-run — protects users from a UI bug
        // accidentally trashing thousands of emails. EL-474 will
        // gate a real auto-execute toggle behind a "I trust this"
        // consent prompt.
        dryRun: true,
        status: "pending",
      },
    });

    // Fire-and-forget. Worker is idempotent so a process death just
    // means a future POST to /api/backfill/{runId}/execute or a
    // future evaluateRun call resumes from row state.
    setImmediate(() => {
      evaluateRun(run.id).catch((err) => {
        logger.error("evaluateRun failed", {
          runId: run.id,
          error: err,
        });
      });
    });

    return NextResponse.json(run, { status: 201 });
  },
  { requestTiming: {} },
);
