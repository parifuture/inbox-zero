import { describe, expect, it } from "vitest";
import {
  patchTouchesFromCondition,
  assertNotSenderLockedFromMutation,
  type RuleFromShape,
} from "@/utils/rule/sender-lock";
import { SafeError } from "@/utils/error";

const lockedRule = (from: string | null = "paypal.com"): RuleFromShape => ({
  from,
  lockedToSenderId: "paypal.com",
});

const unlockedRule = (from: string | null = "paypal.com"): RuleFromShape => ({
  from,
  lockedToSenderId: null,
});

describe("patchTouchesFromCondition", () => {
  it("returns false when patch does not include `from` field", () => {
    expect(patchTouchesFromCondition(lockedRule(), {})).toBe(false);
  });

  it("returns false when patch sets `from` to the same value (no-op)", () => {
    expect(
      patchTouchesFromCondition(lockedRule("paypal.com"), {
        from: "paypal.com",
      }),
    ).toBe(false);
  });

  it("returns false when patch sets `from` null and rule already null (no-op)", () => {
    expect(patchTouchesFromCondition(lockedRule(null), { from: null })).toBe(
      false,
    );
  });

  it("returns true when patch replaces existing `from` with new value", () => {
    expect(
      patchTouchesFromCondition(lockedRule("paypal.com"), {
        from: "stripe.com",
      }),
    ).toBe(true);
  });

  it("returns true when patch clears existing `from` (sets to null)", () => {
    expect(
      patchTouchesFromCondition(lockedRule("paypal.com"), { from: null }),
    ).toBe(true);
  });

  it("returns true when patch adds `from` to a rule with null `from`", () => {
    expect(
      patchTouchesFromCondition(lockedRule(null), { from: "newdomain.com" }),
    ).toBe(true);
  });
});

describe("assertNotSenderLockedFromMutation", () => {
  describe("on unlocked rules", () => {
    it("allows editing the from-field", () => {
      expect(() =>
        assertNotSenderLockedFromMutation(unlockedRule("paypal.com"), {
          from: "stripe.com",
        }),
      ).not.toThrow();
    });

    it("allows clearing the from-field", () => {
      expect(() =>
        assertNotSenderLockedFromMutation(unlockedRule("paypal.com"), {
          from: null,
        }),
      ).not.toThrow();
    });

    it("allows leaving from-field unchanged (patch without `from`)", () => {
      expect(() =>
        assertNotSenderLockedFromMutation(unlockedRule(), {}),
      ).not.toThrow();
    });
  });

  describe("on locked rules", () => {
    it("allows patches that do not touch the from-field", () => {
      expect(() =>
        assertNotSenderLockedFromMutation(lockedRule(), {}),
      ).not.toThrow();
    });

    it("allows no-op patches that set `from` to the same value", () => {
      expect(() =>
        assertNotSenderLockedFromMutation(lockedRule("paypal.com"), {
          from: "paypal.com",
        }),
      ).not.toThrow();
    });

    it("rejects edits that change the from-field to a different value", () => {
      expect(() =>
        assertNotSenderLockedFromMutation(lockedRule("paypal.com"), {
          from: "stripe.com",
        }),
      ).toThrow(SafeError);
    });

    it("rejects edits that clear the from-field entirely", () => {
      expect(() =>
        assertNotSenderLockedFromMutation(lockedRule("paypal.com"), {
          from: null,
        }),
      ).toThrow(SafeError);
    });

    it("rejects edits that add a from-field to a rule with null `from`", () => {
      expect(() =>
        assertNotSenderLockedFromMutation(lockedRule(null), {
          from: "newdomain.com",
        }),
      ).toThrow(SafeError);
    });

    it("throws SafeError with statusCode 403 and clear message", () => {
      try {
        assertNotSenderLockedFromMutation(lockedRule("paypal.com"), {
          from: "stripe.com",
        });
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _unreachable: never = undefined as never;
        throw new Error("expected SafeError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SafeError);
        const safeErr = err as SafeError;
        expect(safeErr.statusCode).toBe(403);
        expect(safeErr.safeMessage).toContain("Sender-locked");
        expect(safeErr.safeMessage).toContain("paypal.com");
        expect(safeErr.safeMessage).toContain("per-sender chat");
      }
    });
  });
});
