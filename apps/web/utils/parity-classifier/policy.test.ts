/** EL-358a — ported from sidecar policy.test.ts. */

import { describe, expect, it } from "vitest";
import { applyPolicy } from "./policy";
import type { ClassificationResult } from "./types";

function makeResult(
  overrides: Partial<ClassificationResult>,
): ClassificationResult {
  return {
    category: "BULK",
    label: null,
    requiresReply: false,
    confidence: 0.9,
    reasoning: "test",
    ...overrides,
  };
}

describe("applyPolicy", () => {
  it("routes to Review when confidence < 0.60", () => {
    const r = applyPolicy(
      makeResult({ confidence: 0.5, category: "PERSONAL" }),
      0.8,
    );
    expect(r.ruleName).toBe("Review");
    expect(r.noMatchFound).toBe(false);
  });

  it("routes to Review at confidence 0.59 (boundary)", () => {
    const r = applyPolicy(
      makeResult({
        confidence: 0.59,
        category: "TRANSACTIONAL",
        label: "Finance",
      }),
      0.9,
    );
    expect(r.ruleName).toBe("Review");
  });

  it("requiresReply wins over BULK", () => {
    const r = applyPolicy(
      makeResult({ category: "BULK", requiresReply: true }),
      0.1,
    );
    expect(r.noMatchFound).toBe(true);
    expect(r.ruleName).toBeNull();
  });

  it("requiresReply wins over TRANSACTIONAL + low score", () => {
    const r = applyPolicy(
      makeResult({
        category: "TRANSACTIONAL",
        requiresReply: true,
        label: null,
      }),
      0.1,
    );
    expect(r.noMatchFound).toBe(true);
  });

  it("requiresReply wins over BULK + label", () => {
    const r = applyPolicy(
      makeResult({
        category: "BULK",
        requiresReply: true,
        label: "Newsletter",
      }),
      0.05,
    );
    expect(r.noMatchFound).toBe(true);
    expect(r.ruleName).toBeNull();
  });

  it("PERSONAL → inbox", () => {
    const r = applyPolicy(makeResult({ category: "PERSONAL" }), 0.3);
    expect(r.noMatchFound).toBe(true);
    expect(r.ruleName).toBeNull();
  });

  it("PERSONAL → inbox even at score 0", () => {
    const r = applyPolicy(makeResult({ category: "PERSONAL" }), 0.0);
    expect(r.noMatchFound).toBe(true);
  });

  it("TRANSACTIONAL + Finance label → Finance", () => {
    const r = applyPolicy(
      makeResult({ category: "TRANSACTIONAL", label: "Finance" }),
      0.2,
    );
    expect(r.ruleName).toBe("Finance");
    expect(r.noMatchFound).toBe(false);
  });

  it("BULK + Newsletter label → Newsletter", () => {
    const r = applyPolicy(
      makeResult({ category: "BULK", label: "Newsletter" }),
      0.1,
    );
    expect(r.ruleName).toBe("Newsletter");
  });

  it("TRANSACTIONAL + no label + score 0.30 → inbox (boundary)", () => {
    const r = applyPolicy(
      makeResult({ category: "TRANSACTIONAL", label: null }),
      0.3,
    );
    expect(r.noMatchFound).toBe(true);
    expect(r.ruleName).toBeNull();
  });

  it("TRANSACTIONAL + no label + score 0.29 → Review (boundary)", () => {
    const r = applyPolicy(
      makeResult({ category: "TRANSACTIONAL", label: null }),
      0.29,
    );
    expect(r.ruleName).toBe("Review");
    expect(r.noMatchFound).toBe(false);
  });

  it("BULK + no label → Review", () => {
    const r = applyPolicy(makeResult({ category: "BULK", label: null }), 0.5);
    expect(r.ruleName).toBe("Review");
  });

  it("BULK + no label → Review even with high score", () => {
    const r = applyPolicy(makeResult({ category: "BULK", label: null }), 0.9);
    expect(r.ruleName).toBe("Review");
  });

  it("unrecognised label is treated as null (BULK → Review)", () => {
    const r = applyPolicy(
      makeResult({ category: "BULK", label: "UnknownLabel" }),
      0.5,
    );
    expect(r.ruleName).toBe("Review");
  });

  it("unrecognised label is treated as null (TRANSACTIONAL high-score → inbox)", () => {
    const r = applyPolicy(
      makeResult({ category: "TRANSACTIONAL", label: "FakeLabel" }),
      0.45,
    );
    expect(r.noMatchFound).toBe(true);
  });
});
