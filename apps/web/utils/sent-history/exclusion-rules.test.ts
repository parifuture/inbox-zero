import { describe, it, expect } from "vitest";
import {
  classifyExclusion,
  __internals,
  EXCLUSION_LABELS,
  type ExclusionReason,
} from "./exclusion-rules";

const NOW = new Date("2026-05-13T12:00:00.000Z");
const D31_AGO = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
const D29_AGO = new Date(NOW.getTime() - 29 * 24 * 60 * 60 * 1000);

const noActivity = {
  lastReceivedAt: D31_AGO,
  lastSentAt: D31_AGO,
  isVip: false,
  now: NOW,
};

describe("exclusion-rules: classifyExclusion (EL-432)", () => {
  // ---------- Rule 1: VIP ----------
  describe("rule 1: vip", () => {
    it("returns 'vip' when isVip=true, regardless of other signals", () => {
      expect(
        classifyExclusion({
          senderEmail: "ceo@chase.com",
          isVip: true,
          now: NOW,
        }),
      ).toBe("vip");
    });

    it("VIP wins over active thread", () => {
      expect(
        classifyExclusion({
          senderEmail: "friend@gmail.com",
          isVip: true,
          lastReceivedAt: NOW,
          now: NOW,
        }),
      ).toBe("vip");
    });
  });

  // ---------- Rule 2: active_thread ----------
  describe("rule 2: active_thread", () => {
    it("flags active when received <30d ago", () => {
      expect(
        classifyExclusion({
          senderEmail: "noreply@somerandombiz.com",
          lastReceivedAt: D29_AGO,
          now: NOW,
        }),
      ).toBe("active_thread");
    });

    it("flags active when sent-to <30d ago", () => {
      expect(
        classifyExclusion({
          senderEmail: "noreply@somerandombiz.com",
          lastSentAt: D29_AGO,
          now: NOW,
        }),
      ).toBe("active_thread");
    });

    it("does NOT flag active when both >30d ago", () => {
      expect(
        classifyExclusion({
          senderEmail: "noreply@somerandombiz.com",
          ...noActivity,
        }),
      ).toBeNull();
    });

    it("active wins over personal_domain", () => {
      expect(
        classifyExclusion({
          senderEmail: "person@gmail.com",
          lastReceivedAt: NOW,
          now: NOW,
        }),
      ).toBe("active_thread");
    });

    it("ignores invalid date strings", () => {
      expect(
        classifyExclusion({
          senderEmail: "noreply@somerandombiz.com",
          lastReceivedAt: "not-a-date",
          now: NOW,
        }),
      ).toBeNull();
    });
  });

  // ---------- Rule 3: protected_class ----------
  describe("rule 3: protected_class", () => {
    it("flags .gov", () => {
      expect(
        classifyExclusion({
          senderEmail: "irs@treasury.gov",
          ...noActivity,
        }),
      ).toBe("protected_class");
    });

    it("flags .edu", () => {
      expect(
        classifyExclusion({
          senderEmail: "alumni@stanford.edu",
          ...noActivity,
        }),
      ).toBe("protected_class");
    });

    it("flags banks (chase.com)", () => {
      expect(
        classifyExclusion({
          senderEmail: "alerts@chase.com",
          ...noActivity,
        }),
      ).toBe("protected_class");
    });

    it("flags bank subdomains (alerts.bofa.com)", () => {
      expect(
        classifyExclusion({
          senderEmail: "alerts@alerts.bofa.com",
          senderDomain: "alerts.bofa.com",
          ...noActivity,
        }),
      ).toBe("protected_class");
    });

    it("flags medical (kaiser.org)", () => {
      expect(
        classifyExclusion({
          senderEmail: "noreply@kaiser.org",
          ...noActivity,
        }),
      ).toBe("protected_class");
    });

    it("flags legal (acmelaw.com → 'law' substring on root)", () => {
      expect(
        classifyExclusion({
          senderEmail: "billing@acmelaw.com",
          ...noActivity,
        }),
      ).toBe("protected_class");
    });

    it("flags school (therenaissanceschool.org)", () => {
      expect(
        classifyExclusion({
          senderEmail: "office@therenaissanceschool.org",
          ...noActivity,
        }),
      ).toBe("protected_class");
    });

    it("does NOT flag microsoft.com as legal even though 'law' isn't in 'microsoft'", () => {
      expect(
        classifyExclusion({
          senderEmail: "support@microsoft.com",
          ...noActivity,
        }),
      ).toBeNull();
    });
  });

  // ---------- Rule 4: ad_site ----------
  describe("rule 4: ad_site", () => {
    it("flags craigslist.org", () => {
      expect(
        classifyExclusion({
          senderEmail: "reply-foo@craigslist.org",
          ...noActivity,
        }),
      ).toBe("ad_site");
    });

    it("flags craigslist subdomains (sfbay.craigslist.org)", () => {
      expect(
        classifyExclusion({
          senderEmail: "reply@sfbay.craigslist.org",
          ...noActivity,
        }),
      ).toBe("ad_site");
    });

    it("flags marketplace.facebook.com", () => {
      expect(
        classifyExclusion({
          senderEmail: "noreply@marketplace.facebook.com",
          ...noActivity,
        }),
      ).toBe("ad_site");
    });

    it("flags zillow.com / offerup.com", () => {
      expect(
        classifyExclusion({ senderEmail: "lead@zillow.com", ...noActivity }),
      ).toBe("ad_site");
      expect(
        classifyExclusion({
          senderEmail: "noreply@offerup.com",
          ...noActivity,
        }),
      ).toBe("ad_site");
    });
  });

  // ---------- Rule 5: careers ----------
  describe("rule 5: careers", () => {
    it("flags careers@", () => {
      expect(
        classifyExclusion({ senderEmail: "careers@mycorp.io", ...noActivity }),
      ).toBe("careers");
    });

    it("flags hr@ / recruiting@ / talent@", () => {
      for (const local of [
        "hr",
        "recruiting",
        "talent",
        "jobs",
        "hiring",
        "apply",
      ]) {
        expect(
          classifyExclusion({
            senderEmail: `${local}@somecompany.io`,
            ...noActivity,
          }),
        ).toBe("careers");
      }
    });

    it("strips +tag from local-part", () => {
      expect(
        classifyExclusion({
          senderEmail: "careers+req123@mycorp.io",
          ...noActivity,
        }),
      ).toBe("careers");
    });

    it("does NOT flag careersupport@ (substring match would be wrong)", () => {
      expect(
        classifyExclusion({
          senderEmail: "careersupport@mycorp.io",
          ...noActivity,
        }),
      ).toBeNull();
    });
  });

  // ---------- Rule 6: personal_domain ----------
  describe("rule 6: personal_domain", () => {
    it("flags gmail.com", () => {
      expect(
        classifyExclusion({ senderEmail: "alice@gmail.com", ...noActivity }),
      ).toBe("personal_domain");
    });

    it("flags yahoo.com / icloud.com / hotmail.com / aol.com", () => {
      for (const dom of ["yahoo.com", "icloud.com", "hotmail.com", "aol.com"]) {
        expect(
          classifyExclusion({
            senderEmail: `bob@${dom}`,
            ...noActivity,
          }),
        ).toBe("personal_domain");
      }
    });

    it("does NOT flag attacker.gmail.com.evil (must be exact match)", () => {
      expect(
        classifyExclusion({
          senderEmail: "x@gmail.com.evil",
          senderDomain: "gmail.com.evil",
          ...noActivity,
        }),
      ).toBeNull();
    });
  });

  // ---------- Returns null when nothing matches ----------
  describe("no exclusion", () => {
    it("returns null for a normal corporate sender with no recent activity", () => {
      expect(
        classifyExclusion({
          senderEmail: "newsletter@somecorp.com",
          ...noActivity,
        }),
      ).toBeNull();
    });
  });

  // ---------- Priority ordering ----------
  describe("priority ordering", () => {
    it("vip > active > protected > ad_site > careers > personal", () => {
      // careers@gmail.com — careers wins over personal
      expect(
        classifyExclusion({ senderEmail: "careers@gmail.com", ...noActivity }),
      ).toBe("careers");
      // careers@craigslist.org — ad_site wins over careers
      expect(
        classifyExclusion({
          senderEmail: "careers@craigslist.org",
          ...noActivity,
        }),
      ).toBe("ad_site");
      // careers@chase.com — protected wins over careers and ad_site
      expect(
        classifyExclusion({ senderEmail: "careers@chase.com", ...noActivity }),
      ).toBe("protected_class");
    });
  });

  // ---------- Edge cases ----------
  describe("edge cases", () => {
    it("upper-case email is normalised", () => {
      expect(
        classifyExclusion({ senderEmail: "Alice@Gmail.COM", ...noActivity }),
      ).toBe("personal_domain");
    });

    it("explicit senderDomain overrides email parsing", () => {
      expect(
        classifyExclusion({
          senderEmail: "weird-format",
          senderDomain: "chase.com",
          ...noActivity,
        }),
      ).toBe("protected_class");
    });

    it("EXCLUSION_LABELS has an entry for every reason", () => {
      const reasons: ExclusionReason[] = [
        "vip",
        "active_thread",
        "protected_class",
        "ad_site",
        "careers",
        "personal_domain",
      ];
      for (const r of reasons) {
        expect(EXCLUSION_LABELS[r]).toBeDefined();
        expect(EXCLUSION_LABELS[r].badge).toBeTruthy();
        expect(EXCLUSION_LABELS[r].tooltip).toBeTruthy();
      }
    });
  });

  // ---------- Internals (sanity) ----------
  describe("__internals (sanity)", () => {
    it("isActive boundary at exactly 30d", () => {
      const exactlyAtBoundary = new Date(
        NOW.getTime() - 30 * 24 * 60 * 60 * 1000,
      );
      expect(__internals.isActive(NOW.getTime(), exactlyAtBoundary, null)).toBe(
        true,
      ); // <= window is inclusive
    });

    it("hasProtectedTld matches .gov but not .government", () => {
      expect(__internals.hasProtectedTld("treasury.gov")).toBe(true);
      expect(__internals.hasProtectedTld("treasury.government")).toBe(false);
    });
  });
});
