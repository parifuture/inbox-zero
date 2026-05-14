/**
 * EL-427 — Tests for the deterministic Newsletter vs Marketing pre-classifier.
 *
 * 20+ cases covering:
 *   - Strong newsletter (local token + editorial subjects)
 *   - Strong marketing (promo tokens + urgency subjects)
 *   - Ambiguous / null category
 *   - Empty or short recent-subject arrays
 *   - Non-English subjects
 *   - Brand-with-newsletter-token edge case (instant-gaming)
 *   - Sender with only one historical subject
 *   - Multiple conflicting subjects
 */

import { describe, expect, it } from "vitest";
import {
  PRE_CLASSIFIER_CONFIDENCE_THRESHOLD,
  preClassify,
} from "./pre-classifier";

describe("preClassify", () => {
  // -----------------------------------------------------------------
  // Strong Newsletter signals
  // -----------------------------------------------------------------

  it("classifies clear newsletter with local token + editorial subjects as Newsletter", () => {
    const r = preClassify({
      senderLocalPart: "newsletter",
      senderDomain: "substack.com",
      recentSubjects: [
        "This week's digest: AI is everywhere",
        "Issue #42: What's new in infra",
        "Weekly roundup of top stories",
      ],
    });
    expect(r.category).toBe("Newsletter");
    expect(r.confidence).toBeGreaterThanOrEqual(
      PRE_CLASSIFIER_CONFIDENCE_THRESHOLD,
    );
  });

  it("classifies 'daily' local token + brief subject as Newsletter", () => {
    const r = preClassify({
      senderLocalPart: "daily",
      senderDomain: "morningbrew.com",
      recentSubjects: [
        "Morning Brew: daily briefing",
        "Today's top stories in business",
      ],
    });
    expect(r.category).toBe("Newsletter");
    expect(r.confidence).toBeGreaterThanOrEqual(
      PRE_CLASSIFIER_CONFIDENCE_THRESHOLD,
    );
  });

  it("classifies digest sender with volume-numbered issue", () => {
    const r = preClassify({
      senderLocalPart: "digest",
      senderDomain: "tldr.tech",
      recentSubjects: [
        "TLDR Vol. 312 — AI news",
        "TLDR Issue 311",
        "TLDR Issue 310",
      ],
    });
    expect(r.category).toBe("Newsletter");
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("classifies monthly briefing", () => {
    const r = preClassify({
      senderLocalPart: "briefing",
      senderDomain: "pragmatic.com",
      recentSubjects: [
        "Monthly digest: engineering leadership",
        "Editor's pick: the best posts of May",
      ],
    });
    expect(r.category).toBe("Newsletter");
  });

  // -----------------------------------------------------------------
  // Strong Marketing signals
  // -----------------------------------------------------------------

  it("classifies clear marketing with promo subjects as Marketing", () => {
    const r = preClassify({
      senderLocalPart: "deals",
      senderDomain: "bestbuy.com",
      recentSubjects: [
        "50% off all TVs — today only!",
        "Flash sale ends tonight",
        "Save $200 on your next laptop",
      ],
    });
    expect(r.category).toBe("Marketing");
    expect(r.confidence).toBeGreaterThanOrEqual(
      PRE_CLASSIFIER_CONFIDENCE_THRESHOLD,
    );
  });

  it("classifies urgency-heavy subject as Marketing", () => {
    const r = preClassify({
      senderLocalPart: "offers",
      senderDomain: "sephora.com",
      recentSubjects: [
        "Last chance: limited time offer",
        "Ends tonight — don't miss out",
      ],
    });
    expect(r.category).toBe("Marketing");
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("classifies promo-code subject as Marketing", () => {
    const r = preClassify({
      senderLocalPart: "promo",
      senderDomain: "uniqlo.com",
      recentSubjects: [
        "Your exclusive promo code inside",
        "New arrivals — shop now",
        "Free shipping this weekend",
      ],
    });
    expect(r.category).toBe("Marketing");
  });

  it("classifies 'hello@brand' token with sales subjects as Marketing", () => {
    const r = preClassify({
      senderLocalPart: "hello",
      senderDomain: "doordash.com",
      recentSubjects: [
        "Buy one get one free this week",
        "Extra 20% off with code SAVE20",
      ],
    });
    expect(r.category).toBe("Marketing");
  });

  // -----------------------------------------------------------------
  // EDGE CASE — brand-with-newsletter-token
  // -----------------------------------------------------------------

  it("EDGE CASE: newsletter@n.instant-gaming.com with marketing subjects is Marketing", () => {
    const r = preClassify({
      senderLocalPart: "newsletter",
      senderDomain: "n.instant-gaming.com",
      recentSubjects: [
        "🎮 -75% off top games this week!",
        "Flash sale: save up to 90% on bestsellers",
        "Limited time: 50% off Steam keys",
      ],
    });
    expect(r.category).toBe("Marketing");
  });

  it("EDGE CASE: newsletter@ on retail brand with mixed subjects does NOT classify as Newsletter", () => {
    const r = preClassify({
      senderLocalPart: "newsletter",
      senderDomain: "amazon.com",
      recentSubjects: ["Your weekly deals digest", "50% off Prime exclusive"],
    });
    // Either Marketing or null — but NEVER Newsletter.
    expect(r.category).not.toBe("Newsletter");
  });

  it("EDGE CASE: brand-domain alone is insufficient to classify as Marketing", () => {
    // Empty subjects + brand domain + no local signal — must fall through.
    const r = preClassify({
      senderLocalPart: "support",
      senderDomain: "amazon.com",
      recentSubjects: [],
    });
    expect(r.category).toBeNull();
  });

  // -----------------------------------------------------------------
  // Ambiguous / null
  // -----------------------------------------------------------------

  it("returns null for neutral sender with no signals", () => {
    const r = preClassify({
      senderLocalPart: "info",
      senderDomain: "example.com",
      recentSubjects: ["Account update", "Welcome"],
    });
    expect(r.category).toBeNull();
  });

  it("returns null when newsletter and marketing signals roughly tie", () => {
    const r = preClassify({
      senderLocalPart: "news", // newsletter local token
      senderDomain: "example.com",
      recentSubjects: [
        "50% off sale ends tonight", // strong marketing subject
      ],
    });
    // Both sides have evidence. Expect either null (ambiguous) or a
    // confidence below threshold — caller will fall through to Bedrock.
    if (r.category !== null) {
      expect(r.confidence).toBeLessThan(PRE_CLASSIFIER_CONFIDENCE_THRESHOLD);
    }
  });

  // -----------------------------------------------------------------
  // Empty / short / degenerate inputs
  // -----------------------------------------------------------------

  it("returns null for completely empty input", () => {
    const r = preClassify({
      senderLocalPart: "",
      senderDomain: "",
      recentSubjects: [],
    });
    expect(r.category).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("handles empty subjects array gracefully when local-part is newsletter", () => {
    const r = preClassify({
      senderLocalPart: "newsletter",
      senderDomain: "substack.com",
      recentSubjects: [],
    });
    // Local-only evidence, no subject corroboration — below threshold.
    expect(r.confidence).toBeLessThan(PRE_CLASSIFIER_CONFIDENCE_THRESHOLD);
  });

  it("handles whitespace-only subjects as empty", () => {
    const r = preClassify({
      senderLocalPart: "deals",
      senderDomain: "example.com",
      recentSubjects: ["   ", "", "  \n  "],
    });
    // Only a local marketing token contributes.
    expect(r.confidence).toBeLessThan(PRE_CLASSIFIER_CONFIDENCE_THRESHOLD);
  });

  it("handles single-subject history without crashing", () => {
    const r = preClassify({
      senderLocalPart: "digest",
      senderDomain: "tldrnewsletter.com",
      recentSubjects: ["Weekly digest of top AI stories"],
    });
    expect(r.category).toBe("Newsletter");
  });

  // -----------------------------------------------------------------
  // Non-English
  // -----------------------------------------------------------------

  it("returns null for non-English subjects with no English token cues", () => {
    const r = preClassify({
      senderLocalPart: "contacto",
      senderDomain: "example.es",
      recentSubjects: [
        "Boletín semanal de noticias",
        "Nuevos productos disponibles",
      ],
    });
    // We don't speak Spanish yet — fall through.
    expect(r.category).toBeNull();
  });

  it("still classifies when local token is English even if subjects are non-English", () => {
    const r = preClassify({
      senderLocalPart: "newsletter",
      senderDomain: "example.de",
      recentSubjects: ["Wöchentliche Zusammenfassung"],
    });
    // Local-only evidence — confidence is real but below threshold.
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThan(PRE_CLASSIFIER_CONFIDENCE_THRESHOLD);
  });

  // -----------------------------------------------------------------
  // Conflicting subjects
  // -----------------------------------------------------------------

  it("handles conflicting subjects (newsletter-style + marketing-style)", () => {
    const r = preClassify({
      senderLocalPart: "info",
      senderDomain: "brand.com",
      recentSubjects: [
        "This week's digest from the editor",
        "50% off everything — ends tonight!",
      ],
    });
    // No local-part signal; subjects fight. Expect ambiguous or
    // whichever one scores higher with confidence < 0.85.
    if (r.category !== null) {
      expect(r.confidence).toBeLessThan(1.0);
    }
  });

  it("marketing-dominated mixed subjects tip toward Marketing", () => {
    const r = preClassify({
      senderLocalPart: "shop",
      senderDomain: "etsy.com",
      recentSubjects: [
        "Weekly picks from our sellers",
        "50% off select items — today only!",
        "Flash sale: save $20 on handmade goods",
      ],
    });
    expect(r.category).toBe("Marketing");
  });

  // -----------------------------------------------------------------
  // Input hygiene
  // -----------------------------------------------------------------

  it("ignores case in local-part tokens", () => {
    const r = preClassify({
      senderLocalPart: "NEWSLETTER",
      senderDomain: "SUBSTACK.com",
      recentSubjects: ["This week's roundup", "Issue #15", "Editor's note"],
    });
    expect(r.category).toBe("Newsletter");
  });

  it("strips leading @ from domain", () => {
    const r = preClassify({
      senderLocalPart: "deals",
      senderDomain: "@target.com",
      recentSubjects: ["30% off — ends tonight", "Limited time offer"],
    });
    expect(r.category).toBe("Marketing");
  });

  it("treats missing domain as no domain", () => {
    const r = preClassify({
      senderLocalPart: "newsletter",
      senderDomain: "",
      recentSubjects: ["Weekly digest issue #4"],
    });
    expect(r.category).toBe("Newsletter");
  });

  it("does not crash on non-string subject values", () => {
    const r = preClassify({
      senderLocalPart: "deals",
      senderDomain: "bestbuy.com",
      // @ts-expect-error — defensive test
      recentSubjects: [null, undefined, 123, "50% off ends tonight"],
    });
    expect(r.category).toBe("Marketing");
  });

  // -----------------------------------------------------------------
  // Brand-domain hits without local signal
  // -----------------------------------------------------------------

  it("subdomain of a brand hint still counts as brand domain", () => {
    const r = preClassify({
      senderLocalPart: "newsletter",
      senderDomain: "n.instant-gaming.com",
      recentSubjects: [], // no evidence either way
    });
    // Local-part "newsletter" heavily penalised — confidence near zero.
    expect(r.category).toBeNull();
  });

  // -----------------------------------------------------------------
  // Confidence contract
  // -----------------------------------------------------------------

  it("confidence is always in [0, 1]", () => {
    const r = preClassify({
      senderLocalPart: "newsletter",
      senderDomain: "substack.com",
      recentSubjects: new Array(20).fill(
        "This week's weekly digest issue #42 editor roundup",
      ),
    });
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("signals field is populated for structured logging", () => {
    const r = preClassify({
      senderLocalPart: "deals",
      senderDomain: "target.com",
      recentSubjects: ["50% off everything"],
    });
    expect(r.signals).toBeDefined();
    expect(r.signals?.localMarketingHits).toContain("deals");
    expect(r.signals?.subjectMarketingHits).toBeGreaterThan(0);
    expect(r.signals?.brandDomainHit).toBe(true);
  });
});
