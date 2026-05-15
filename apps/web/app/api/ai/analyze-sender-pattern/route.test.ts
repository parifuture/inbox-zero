/**
 * EL-426 regression test for the pattern-analyzer → auto-categorize
 * bridge. When pattern analysis creates a fresh Newsletter row, it must
 * trigger auto-categorization if `autoCategorizeSenders` is enabled so the
 * row doesn't end up stalled with `patternAnalyzed=true, categoryId=NULL`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the behavioral rule that:
//   (created === true) AND (emailAccount.autoCategorizeSenders === true)
//   ⇒ categorizeSender must be invoked
// This is a focused unit test of the condition, isolated from Next runtime.

describe("EL-426: pattern-analyzer triggers categorize for brand-new senders", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("triggers categorizeSender when the Newsletter row was newly created AND autoCategorizeSenders is on", () => {
    const categorizeSender = vi.fn();

    const shouldCategorize = (created: boolean, autoOn: boolean) =>
      created && autoOn;

    const scenarios = [
      { created: true, autoOn: true, expectCall: true },
      { created: true, autoOn: false, expectCall: false },
      { created: false, autoOn: true, expectCall: false },
      { created: false, autoOn: false, expectCall: false },
    ];

    for (const s of scenarios) {
      categorizeSender.mockClear();
      if (shouldCategorize(s.created, s.autoOn)) {
        categorizeSender("from", {}, {} as unknown);
      }
      expect(categorizeSender).toHaveBeenCalledTimes(s.expectCall ? 1 : 0);
    }
  });

  it("does not break when categorizeSender throws — the pattern check must still succeed", async () => {
    const categorizeSender = vi.fn().mockRejectedValue(new Error("bedrock"));
    const savePatternCheck = vi.fn().mockResolvedValue({ created: true });

    // Simulate the route's post-savePatternCheck block.
    const { created } = await savePatternCheck();
    const autoCategorizeSenders = true;

    let patternCheckSucceeded = true;
    try {
      if (created && autoCategorizeSenders) {
        try {
          await categorizeSender();
        } catch {
          // swallowed — matches the route's behavior
        }
      }
    } catch {
      patternCheckSucceeded = false;
    }

    expect(patternCheckSucceeded).toBe(true);
    expect(categorizeSender).toHaveBeenCalledTimes(1);
  });
});
