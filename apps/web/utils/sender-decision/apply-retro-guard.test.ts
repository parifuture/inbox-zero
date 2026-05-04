import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_APPLY_RETRO_HARD_CAP,
  DEFAULT_APPLY_RETRO_SOFT_CAP,
  evaluateApplyRetroGuard,
  previewApplierBlastRadius,
} from "./apply-retro-guard";
import { createTestLogger } from "@/__tests__/helpers";

const logger = createTestLogger();

function preview(count: number, overHardCap = false) {
  return { query: "q", count, overHardCap };
}

describe("evaluateApplyRetroGuard", () => {
  const softCap = DEFAULT_APPLY_RETRO_SOFT_CAP;
  const hardCap = DEFAULT_APPLY_RETRO_HARD_CAP;

  it("allows under-soft-cap without confirm", () => {
    const r = evaluateApplyRetroGuard({
      preview: preview(50),
      softCap,
      hardCap,
      body: {},
    });
    expect(r).toEqual({ ok: true, requiresOverrideLog: false });
  });

  it("rejects over-soft-cap without confirm (409)", () => {
    const r = evaluateApplyRetroGuard({
      preview: preview(500),
      softCap,
      hardCap,
      body: {},
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.code).toBe("confirmation_required");
  });

  it("rejects over-soft-cap when expectedCount mismatches (409)", () => {
    const r = evaluateApplyRetroGuard({
      preview: preview(500),
      softCap,
      hardCap,
      body: { confirm: true, expectedCount: 499 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.code).toBe("expected_count_mismatch");
  });

  it("accepts over-soft-cap with matching confirm/expectedCount", () => {
    const r = evaluateApplyRetroGuard({
      preview: preview(500),
      softCap,
      hardCap,
      body: { confirm: true, expectedCount: 500 },
    });
    expect(r).toEqual({ ok: true, requiresOverrideLog: false });
  });

  it("rejects over-hard-cap without override (400)", () => {
    const r = evaluateApplyRetroGuard({
      preview: preview(hardCap + 1, true),
      softCap,
      hardCap,
      body: { confirm: true, expectedCount: hardCap + 1 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.code).toBe("hard_cap_exceeded");
  });

  it("accepts over-hard-cap with confirm + override and flags override log", () => {
    const r = evaluateApplyRetroGuard({
      preview: preview(hardCap + 1, true),
      softCap,
      hardCap,
      body: { confirm: true, override: true },
    });
    expect(r).toEqual({ ok: true, requiresOverrideLog: true });
  });

  it("treats count > hardCap without overHardCap flag as hard-cap too", () => {
    const r = evaluateApplyRetroGuard({
      preview: preview(hardCap + 5, false),
      softCap,
      hardCap,
      body: { confirm: true, expectedCount: hardCap + 5 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("hard_cap_exceeded");
  });
});

describe("previewApplierBlastRadius", () => {
  it("delegates to deps.listMessageIds and tags query", async () => {
    const listMessageIds = vi
      .fn()
      .mockResolvedValue({ count: 17, overHardCap: false });
    const result = await previewApplierBlastRadius({
      senderEmail: "foo@bar.com",
      action: "auto_trash",
      hardCap: 2000,
      logger,
      deps: { gmail: {} as any, listMessageIds },
    });
    expect(result).toEqual({
      count: 17,
      overHardCap: false,
      query: "from:foo@bar.com -in:sent -is:starred -in:trash",
    });
    expect(listMessageIds).toHaveBeenCalledWith(
      "from:foo@bar.com -in:sent -is:starred -in:trash",
      2000,
    );
  });

  it("reports overHardCap passthrough", async () => {
    const listMessageIds = vi
      .fn()
      .mockResolvedValue({ count: 2001, overHardCap: true });
    const result = await previewApplierBlastRadius({
      senderEmail: "foo@bar.com",
      action: "auto_archive",
      hardCap: 2000,
      logger,
      deps: { gmail: {} as any, listMessageIds },
    });
    expect(result.overHardCap).toBe(true);
    expect(result.count).toBe(2001);
  });
});
