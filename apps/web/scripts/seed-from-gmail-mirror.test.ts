/**
 * EL-385 — Unit tests for the pure mapping & arg-parsing helpers used by
 * `seed-from-gmail-mirror.ts`. No Prisma, no sidecar, no SQLite required.
 */

import { describe, expect, it } from "vitest";
import {
  classifyMirrorSender,
  mapSidecarAction,
  parseArgs,
  type MirrorSenderRow,
  type SidecarTruthRow,
} from "./seed-from-gmail-mirror.lib";

function truth(partial: Partial<SidecarTruthRow>): SidecarTruthRow {
  return {
    senderEmail: "x@y.com",
    category: null,
    action: null,
    source: null,
    ...partial,
  };
}

describe("mapSidecarAction", () => {
  it("returns auto_trash for explicit trash action", () => {
    expect(mapSidecarAction(truth({ action: "TRASH" }))).toBe("auto_trash");
  });

  it.each([
    "bulk",
    "marketing",
    "promotional",
  ])("returns auto_trash for category=%s", (category) => {
    expect(mapSidecarAction(truth({ category }))).toBe("auto_trash");
  });

  it.each([
    ["transactional", null],
    ["receipts", null],
    ["sent-history", null],
    [null, "archive"],
    [null, "inbox"],
    [null, "keep"],
  ])("returns always_keep for category=%s action=%s", (category, action) => {
    expect(mapSidecarAction(truth({ category, action }))).toBe("always_keep");
  });

  it("falls back to review for unknown / empty rows", () => {
    expect(mapSidecarAction(truth({}))).toBe("review");
    expect(
      mapSidecarAction(truth({ category: "mystery", action: "ponder" })),
    ).toBe("review");
  });

  it("ignores case", () => {
    expect(mapSidecarAction(truth({ category: "BULK" }))).toBe("auto_trash");
    expect(mapSidecarAction(truth({ category: "Transactional" }))).toBe(
      "always_keep",
    );
  });
});

describe("classifyMirrorSender", () => {
  const row: MirrorSenderRow = {
    fromAddress: '"Thing" <bulk@example.com>',
    messageCount: 42,
    firstSeenEpoch: 1_700_000_000,
    lastSeenEpoch: 1_800_000_000,
  };

  it("uses sidecar classification when a match exists", () => {
    const lookup = new Map<string, SidecarTruthRow>();
    lookup.set(
      "bulk@example.com",
      truth({ senderEmail: "bulk@example.com", category: "marketing" }),
    );
    const r = classifyMirrorSender(row, lookup);
    expect(r.action).toBe("auto_trash");
    expect(r.reason).toBe("sidecar");
    expect(r.truth?.category).toBe("marketing");
  });

  it("defaults to review when sidecar has no match", () => {
    const r = classifyMirrorSender(row, new Map());
    expect(r.action).toBe("review");
    expect(r.reason).toBe("review-default");
    expect(r.truth).toBeNull();
  });

  it("defaults to review when no lookup is provided", () => {
    const r = classifyMirrorSender(row, null);
    expect(r.action).toBe("review");
    expect(r.reason).toBe("review-default");
  });

  it("canonicalizes the sender before lookup (strips display + lowercases)", () => {
    const lookup = new Map<string, SidecarTruthRow>();
    lookup.set(
      "promo@example.com",
      truth({ senderEmail: "promo@example.com", category: "promotional" }),
    );
    const r = classifyMirrorSender(
      {
        ...row,
        fromAddress: '"Promo Team" <Promo+Daily@Example.com>',
      },
      lookup,
    );
    expect(r.action).toBe("auto_trash");
    expect(r.reason).toBe("sidecar");
  });

  it("returns review for an unparseable sender", () => {
    const r = classifyMirrorSender(
      { ...row, fromAddress: "not-an-email" },
      new Map([["x", truth({})]]),
    );
    expect(r.action).toBe("review");
    expect(r.reason).toBe("review-default");
  });
});

describe("parseArgs", () => {
  it("parses string / number / boolean flags", () => {
    const out = parseArgs(
      ["--email-account", "a@b.com", "--limit", "250", "--apply"],
      {
        string: ["email-account"],
        number: ["limit"],
        boolean: ["apply", "dry-run"],
      },
    );
    expect(out["email-account"]).toBe("a@b.com");
    expect(out.limit).toBe(250);
    expect(out.apply).toBe(true);
    expect(out["dry-run"]).toBeUndefined();
  });

  it("supports --key=value form", () => {
    const out = parseArgs(["--limit=10", "--email-account=x@y.com"], {
      string: ["email-account"],
      number: ["limit"],
    });
    expect(out.limit).toBe(10);
    expect(out["email-account"]).toBe("x@y.com");
  });

  it("defaults a bare boolean to true", () => {
    const out = parseArgs(["--dry-run"], { boolean: ["dry-run"] });
    expect(out["dry-run"]).toBe(true);
  });

  it("treats --flag=false as false for booleans", () => {
    const out = parseArgs(["--apply=false"], { boolean: ["apply"] });
    expect(out.apply).toBe(false);
  });

  it("throws if a number flag has no numeric value", () => {
    expect(() => parseArgs(["--limit", "nope"], { number: ["limit"] })).toThrow(
      /--limit/,
    );
  });

  it("throws if a string flag is missing its value", () => {
    expect(() =>
      parseArgs(["--email-account"], { string: ["email-account"] }),
    ).toThrow(/--email-account/);
  });
});
