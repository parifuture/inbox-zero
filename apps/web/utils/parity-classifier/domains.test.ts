/** EL-358a — lookupDomainCategory + CATEGORY_RULE_NAMES sanity checks. */

import { describe, expect, it } from "vitest";
import {
  CATEGORY_RULE_NAMES,
  DOMAIN_RULES,
  lookupDomainCategory,
} from "./domains";

describe("lookupDomainCategory", () => {
  it("returns null for unknown senders", () => {
    expect(
      lookupDomainCategory(
        "stranger@unknown-example.com",
        "unknown-example.com",
      ),
    ).toBeNull();
  });

  it("matches exact domains case-insensitively", () => {
    expect(lookupDomainCategory("Billing@Paypal.com", "Paypal.com")).toBe(
      "finance",
    );
  });

  it("matches Kickstarter", () => {
    expect(
      lookupDomainCategory("noreply@kickstarter.com", "kickstarter.com"),
    ).toBe("kickstarter");
  });

  it("matches substrings when exact-domain misses", () => {
    expect(
      lookupDomainCategory(
        "bot@orders.fastrak-example.net",
        "orders.fastrak-example.net",
      ),
    ).toBe("finance");
  });

  it("routes Tesla insurance subdomain", () => {
    expect(
      lookupDomainCategory(
        "reply@reply.teslainsuranceservices.com",
        "reply.teslainsuranceservices.com",
      ),
    ).toBe("tesla");
  });

  it("does NOT misroute phishing celsiusnetwork.com", () => {
    // celsius.network is legit; celsiusnetwork.com is phishing and must NOT match.
    expect(
      lookupDomainCategory("noreply@celsiusnetwork.com", "celsiusnetwork.com"),
    ).toBeNull();
  });

  it("every rule has a rule-name mapping", () => {
    for (const rule of DOMAIN_RULES) {
      expect(CATEGORY_RULE_NAMES[rule.category]).toBeDefined();
    }
  });
});
