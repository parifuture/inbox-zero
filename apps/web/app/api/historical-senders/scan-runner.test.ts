import { describe, it, expect } from "vitest";
import {
  buildArchiveQuery,
  buildScanQuery,
} from "@/app/api/historical-senders/scan-runner";

describe("historical-senders query builders (EL-323 safety filters)", () => {
  describe("buildScanQuery", () => {
    it("formats the date as YYYY/MM/DD UTC", () => {
      const q = buildScanQuery(new Date("2024-01-01T00:00:00.000Z"));
      expect(q).toContain("before:2024/01/01");
    });

    it("always excludes sent mail from the aggregation", () => {
      const q = buildScanQuery(new Date("2024-01-01T00:00:00.000Z"));
      expect(q).toContain("-in:sent");
    });

    it("always excludes trash from the aggregation", () => {
      const q = buildScanQuery(new Date("2024-01-01T00:00:00.000Z"));
      expect(q).toContain("-in:trash");
    });

    it("respects month/day with zero-padding across locales", () => {
      // UTC date in January → cross-locale guard: this should NOT come out
      // as "before:2024/1/1" even though the runner formats from Date parts.
      const q = buildScanQuery(new Date("2024-01-01T00:00:00.000Z"));
      expect(q).toMatch(/^before:\d{4}\/\d{2}\/\d{2}/);
    });
  });

  describe("buildArchiveQuery", () => {
    it("scopes to the sender and the pre-2024 cutoff", () => {
      const q = buildArchiveQuery("foo@bar.com");
      expect(q).toContain("from:foo@bar.com");
      expect(q).toContain("before:2024/01/01");
    });

    it("only touches inbox and explicitly excludes sent + trash", () => {
      const q = buildArchiveQuery("foo@bar.com");
      expect(q).toContain("in:inbox");
      expect(q).toContain("-in:sent");
      expect(q).toContain("-in:trash");
    });

    it("explicitly excludes starred messages (EL-432 defence-in-depth)", () => {
      const q = buildArchiveQuery("foo@bar.com");
      expect(q).toContain("-is:starred");
    });

    it("includes the literal sender verbatim (no URL-encoding surprises)", () => {
      const q = buildArchiveQuery("first.last+tag@Example.Com");
      expect(q).toContain("from:first.last+tag@Example.Com");
    });
  });
});
