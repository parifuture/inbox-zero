/**
 * EL-363 — parity verification harness.
 *
 * Pure metric computations over `ParityDecision` rows that have been joined
 * against the sidecar's `spam_decisions` table (the sidecar source of truth
 * until the fork's parity classifier graduates out of shadow mode).
 *
 * The only inputs are plain JS values — no Prisma client, no env, no I/O.
 * This keeps the module trivially unit-testable and composable with the
 * admin API route, CLI report, and eventual EL-376 dashboard.
 *
 * Agreement semantics:
 *   - A row is _comparable_ iff both `action` and `sidecarAction` are set.
 *   - A row is _agreed_ iff `action === sidecarAction`. We intentionally do
 *     NOT compare `ruleName`s for top-line agreement (different rule names
 *     can resolve to the same user-facing outcome) — ruleName drift is
 *     tracked separately under `ruleDrift` for qualitative review.
 *   - Per-stage breakdown uses the fork's `stage` (0..4). Same-stage drift
 *     within the sidecar is captured via `stageDrift` (fork stage → sidecar
 *     rule_name distribution) but that's only useful once the sidecar logs
 *     its own stage, which it does via `stage_decided`.
 */

export type ParityAction = "inbox" | "review" | "noMatch" | "trash";

export interface ParityRow {
  /** Fork decision. */
  action: ParityAction | string;
  /** When the fork row was recorded. Not used in aggregates today; kept for
   *  future time-windowed breakdowns. */
  createdAt?: Date;
  /** Fork rule name (nullable for stage-4 category-only outcomes). */
  ruleName: string | null;
  /** Sidecar decision, when known. Null rows are counted as `uncompared`. */
  sidecarAction: ParityAction | string | null;
  /** Sidecar rule name, when known. */
  sidecarRuleName: string | null;
  /** Sidecar pipeline stage (null if the sidecar join didn't populate it). */
  sidecarStage?: number | null;
  /** Fork pipeline stage that produced the fork decision. */
  stage: number;
}

export interface StageBreakdown {
  agreed: number;
  /** 0..1, null when compared === 0. */
  agreementRate: number | null;
  compared: number;
  stage: number;
  total: number;
}

export interface ActionDrift {
  count: number;
  forkAction: string;
  sidecarAction: string;
}

export interface RuleDrift {
  count: number;
  forkRuleName: string | null;
  sidecarRuleName: string | null;
}

export interface AgreementStats {
  /** Sorted desc by count, top-20. Only populated for rows where the two
   *  actions differ. */
  actionDrift: ActionDrift[];
  agreed: number;
  /** 0..1, null when compared === 0. */
  agreementRate: number | null;
  compared: number;
  /** Sorted desc by count, top-20. Only populated for rows where the two
   *  rule names differ (and at least one is non-null). */
  ruleDrift: RuleDrift[];
  stages: StageBreakdown[];
  total: number;
  uncompared: number;
}

function incr<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

export function computeAgreementStats(rows: ParityRow[]): AgreementStats {
  const total = rows.length;
  let compared = 0;
  let agreed = 0;

  // stage -> { total, compared, agreed }
  const stageMap = new Map<
    number,
    { total: number; compared: number; agreed: number }
  >();

  const actionDriftMap = new Map<string, number>(); // `${fork}::${sidecar}`
  const ruleDriftMap = new Map<string, number>(); // `${fork}::${sidecar}`

  for (const row of rows) {
    const stageBucket = stageMap.get(row.stage) ?? {
      total: 0,
      compared: 0,
      agreed: 0,
    };
    stageBucket.total += 1;

    if (row.sidecarAction != null) {
      compared += 1;
      stageBucket.compared += 1;
      if (row.action === row.sidecarAction) {
        agreed += 1;
        stageBucket.agreed += 1;
      } else {
        incr(actionDriftMap, `${row.action}::${row.sidecarAction}`);
      }

      if (
        (row.ruleName ?? null) !== (row.sidecarRuleName ?? null) &&
        // Skip all-null — uninteresting.
        (row.ruleName != null || row.sidecarRuleName != null)
      ) {
        incr(
          ruleDriftMap,
          `${row.ruleName ?? "∅"}::${row.sidecarRuleName ?? "∅"}`,
        );
      }
    }

    stageMap.set(row.stage, stageBucket);
  }

  const stages: StageBreakdown[] = [...stageMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stage, b]) => ({
      stage,
      total: b.total,
      compared: b.compared,
      agreed: b.agreed,
      agreementRate: b.compared === 0 ? null : b.agreed / b.compared,
    }));

  const actionDrift: ActionDrift[] = [...actionDriftMap.entries()]
    .map(([key, count]) => {
      const [forkAction, sidecarAction] = key.split("::");
      return { forkAction, sidecarAction, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const ruleDrift: RuleDrift[] = [...ruleDriftMap.entries()]
    .map(([key, count]) => {
      const [fork, sidecar] = key.split("::");
      return {
        forkRuleName: fork === "∅" ? null : fork,
        sidecarRuleName: sidecar === "∅" ? null : sidecar,
        count,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    total,
    compared,
    uncompared: total - compared,
    agreed,
    agreementRate: compared === 0 ? null : agreed / compared,
    stages,
    actionDrift,
    ruleDrift,
  };
}

/**
 * Emit a flat, grep-friendly log entry. Callers pipe this through their
 * normal structured logger; we return the payload rather than logging
 * directly so the function stays pure.
 */
export function buildAgreementLogPayload(stats: AgreementStats): {
  event: "parity.agreement";
  total: number;
  compared: number;
  agreed: number;
  agreement_rate: number | null;
  stage_rates: Array<{ stage: number; rate: number | null; compared: number }>;
  top_action_drift: Array<{ from: string; to: string; count: number }>;
} {
  return {
    event: "parity.agreement",
    total: stats.total,
    compared: stats.compared,
    agreed: stats.agreed,
    agreement_rate:
      stats.agreementRate === null
        ? null
        : Number(stats.agreementRate.toFixed(4)),
    stage_rates: stats.stages.map((s) => ({
      stage: s.stage,
      rate:
        s.agreementRate === null ? null : Number(s.agreementRate.toFixed(4)),
      compared: s.compared,
    })),
    top_action_drift: stats.actionDrift.slice(0, 5).map((d) => ({
      from: d.forkAction,
      to: d.sidecarAction,
      count: d.count,
    })),
  };
}
