/**
 * EL-363 — parity verification data loader.
 *
 * Pulls `ParityDecision` rows joined against the sidecar columns we've
 * populated via `scripts/backfill-sidecar-decisions.ts`. Returns a minimal
 * shape that slots straight into `computeAgreementStats` without further
 * massaging.
 *
 * Kept separate from `metrics.ts` so the metrics module stays pure and the
 * loader can be swapped for mocks in tests.
 */

import prisma from "@/utils/prisma";
import type { ParityRow } from "./metrics";

export interface LoadParityRowsOptions {
  emailAccountId?: string;
  /** Hard cap on rows returned. Default 50k. */
  limit?: number;
  /** Inclusive lower bound on `createdAt`. */
  since?: Date;
  /** Exclusive upper bound on `createdAt`. */
  until?: Date;
}

export async function loadParityRows(
  opts: LoadParityRowsOptions = {},
): Promise<ParityRow[]> {
  const { emailAccountId, since, until, limit = 50_000 } = opts;

  const rows = await prisma.parityDecision.findMany({
    where: {
      ...(emailAccountId ? { emailAccountId } : {}),
      ...(since || until
        ? {
            createdAt: {
              ...(since ? { gte: since } : {}),
              ...(until ? { lt: until } : {}),
            },
          }
        : {}),
    },
    select: {
      stage: true,
      action: true,
      ruleName: true,
      sidecarAction: true,
      sidecarRuleName: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return rows.map((r) => ({
    stage: r.stage,
    action: r.action,
    ruleName: r.ruleName,
    sidecarAction: r.sidecarAction,
    sidecarRuleName: r.sidecarRuleName,
    createdAt: r.createdAt,
  }));
}
