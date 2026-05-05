import { describe, expect, it } from "vitest";
import {
  type ParityRow,
  buildAgreementLogPayload,
  computeAgreementStats,
} from "./metrics";

const row = (partial: Partial<ParityRow>): ParityRow => ({
  stage: 0,
  action: "inbox",
  ruleName: null,
  sidecarAction: null,
  sidecarRuleName: null,
  ...partial,
});

describe("computeAgreementStats", () => {
  it("returns an empty-compared result for an empty input", () => {
    const stats = computeAgreementStats([]);
    expect(stats).toMatchObject({
      total: 0,
      compared: 0,
      uncompared: 0,
      agreed: 0,
      agreementRate: null,
      stages: [],
      actionDrift: [],
      ruleDrift: [],
    });
  });

  it("counts rows without a sidecar decision as uncompared", () => {
    const stats = computeAgreementStats([
      row({ stage: 0, action: "inbox" }),
      row({ stage: 1, action: "trash" }),
    ]);
    expect(stats.total).toBe(2);
    expect(stats.compared).toBe(0);
    expect(stats.uncompared).toBe(2);
    expect(stats.agreementRate).toBeNull();
    expect(stats.stages).toHaveLength(2);
    expect(stats.stages[0]).toMatchObject({
      stage: 0,
      total: 1,
      compared: 0,
      agreed: 0,
      agreementRate: null,
    });
  });

  it("computes overall agreement rate when actions match", () => {
    const rows: ParityRow[] = [
      row({ stage: 0, action: "inbox", sidecarAction: "inbox" }),
      row({ stage: 1, action: "trash", sidecarAction: "trash" }),
      row({ stage: 2, action: "review", sidecarAction: "inbox" }),
      row({ stage: 2, action: "review", sidecarAction: null }),
    ];
    const stats = computeAgreementStats(rows);
    expect(stats.total).toBe(4);
    expect(stats.compared).toBe(3);
    expect(stats.uncompared).toBe(1);
    expect(stats.agreed).toBe(2);
    expect(stats.agreementRate).toBeCloseTo(2 / 3);
  });

  it("produces per-stage breakdowns sorted by stage asc", () => {
    const rows: ParityRow[] = [
      row({ stage: 3, action: "review", sidecarAction: "review" }),
      row({ stage: 3, action: "review", sidecarAction: "inbox" }),
      row({ stage: 0, action: "inbox", sidecarAction: "inbox" }),
    ];
    const stats = computeAgreementStats(rows);
    expect(stats.stages.map((s) => s.stage)).toEqual([0, 3]);
    const s3 = stats.stages.find((s) => s.stage === 3);
    expect(s3).toMatchObject({
      total: 2,
      compared: 2,
      agreed: 1,
      agreementRate: 0.5,
    });
  });

  it("captures top action-drift pairs sorted by count desc", () => {
    const rows: ParityRow[] = [
      ...Array.from({ length: 5 }, () =>
        row({ action: "trash", sidecarAction: "inbox" }),
      ),
      ...Array.from({ length: 2 }, () =>
        row({ action: "review", sidecarAction: "inbox" }),
      ),
      row({ action: "trash", sidecarAction: "trash" }), // agreement, ignored
    ];
    const stats = computeAgreementStats(rows);
    expect(stats.actionDrift[0]).toEqual({
      forkAction: "trash",
      sidecarAction: "inbox",
      count: 5,
    });
    expect(stats.actionDrift[1]).toEqual({
      forkAction: "review",
      sidecarAction: "inbox",
      count: 2,
    });
  });

  it("captures rule-name drift distinct from action drift", () => {
    const rows: ParityRow[] = [
      row({
        action: "inbox",
        sidecarAction: "inbox",
        ruleName: "vip-sender",
        sidecarRuleName: "protected-domain",
      }),
      row({
        action: "inbox",
        sidecarAction: "inbox",
        ruleName: "vip-sender",
        sidecarRuleName: "protected-domain",
      }),
      row({
        action: "inbox",
        sidecarAction: "inbox",
        ruleName: null,
        sidecarRuleName: null, // all-null, skipped
      }),
    ];
    const stats = computeAgreementStats(rows);
    expect(stats.compared).toBe(3);
    expect(stats.agreed).toBe(3);
    expect(stats.ruleDrift).toEqual([
      {
        forkRuleName: "vip-sender",
        sidecarRuleName: "protected-domain",
        count: 2,
      },
    ]);
  });
});

describe("buildAgreementLogPayload", () => {
  it("rounds rates to 4 decimals and limits top drift", () => {
    const rows: ParityRow[] = [
      row({ stage: 0, action: "inbox", sidecarAction: "inbox" }),
      row({ stage: 0, action: "inbox", sidecarAction: "inbox" }),
      row({ stage: 0, action: "inbox", sidecarAction: "trash" }),
    ];
    const stats = computeAgreementStats(rows);
    const payload = buildAgreementLogPayload(stats);
    expect(payload.event).toBe("parity.agreement");
    expect(payload.agreement_rate).toBeCloseTo(0.6667, 4);
    expect(payload.stage_rates[0]).toMatchObject({
      stage: 0,
      compared: 3,
    });
    expect(payload.top_action_drift).toHaveLength(1);
  });

  it("emits null agreement_rate when nothing is compared", () => {
    const stats = computeAgreementStats([row({ stage: 0, action: "inbox" })]);
    const payload = buildAgreementLogPayload(stats);
    expect(payload.agreement_rate).toBeNull();
    expect(payload.stage_rates[0].rate).toBeNull();
  });
});
