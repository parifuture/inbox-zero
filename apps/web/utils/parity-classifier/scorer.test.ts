/** EL-358a — ported from sidecar scorer.test.ts + two fork-specific cases. */

import { describe, expect, it } from "vitest";
import { INBOX_THRESHOLD, REVIEW_THRESHOLD, computeScore } from "./scorer";
import type { SenderAggregate } from "./types";

function makeAggregate(overrides: Partial<SenderAggregate>): SenderAggregate {
  return {
    address: "alice@example.com",
    domain: "example.com",
    replyCount: 0,
    totalSentToThem: 0,
    totalReceivedFrom: 0,
    initiationRatio: 0.5,
    firstSeen: null,
    lastReceived: null,
    lastReplied: null,
    ...overrides,
  };
}

describe("computeScore — high relationship", () => {
  it("scores >= INBOX_THRESHOLD for frequent, recent replies", () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000);
    const result = computeScore(
      makeAggregate({
        replyCount: 15,
        totalReceivedFrom: 20,
        lastReplied: twoWeeksAgo,
        initiationRatio: 0.3,
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(INBOX_THRESHOLD);
    expect(result.source).toBe("history");
  });
});

describe("computeScore — cold relationship", () => {
  it("scores <= REVIEW_THRESHOLD for a sender never replied to", () => {
    const result = computeScore(
      makeAggregate({ replyCount: 0, totalReceivedFrom: 3, lastReplied: null }),
    );
    expect(result.score).toBeLessThanOrEqual(REVIEW_THRESHOLD);
  });
});

describe("computeScore — stale relationship", () => {
  it("scores between thresholds for replies 2 years ago", () => {
    const twoYearsAgo = new Date(Date.now() - 730 * 24 * 3600 * 1000);
    const result = computeScore(
      makeAggregate({
        replyCount: 5,
        totalReceivedFrom: 10,
        lastReplied: twoYearsAgo,
        initiationRatio: 0.4,
      }),
    );
    expect(result.score).toBeGreaterThan(REVIEW_THRESHOLD);
    expect(result.score).toBeLessThan(INBOX_THRESHOLD);
  });
});

describe("computeScore — cold start (null aggregate)", () => {
  it("uses free-provider prior for gmail", () => {
    const result = computeScore(null, new Date(), "alice@gmail.com");
    expect(result.source).toBe("domain_prior");
    expect(result.score).toBeLessThanOrEqual(REVIEW_THRESHOLD);
    expect(result.score).toBeGreaterThan(0);
  });
  it("gives unknown corporate domain a score between thresholds", () => {
    const result = computeScore(null, new Date(), "alice@example.com");
    expect(result.source).toBe("domain_prior");
    expect(result.score).toBeGreaterThan(REVIEW_THRESHOLD);
    expect(result.score).toBeLessThan(INBOX_THRESHOLD);
  });
  it("returns no_data when no aggregate and no address", () => {
    const result = computeScore(null);
    expect(result.source).toBe("no_data");
    expect(result.score).toBe(0);
  });
  it("gives bulk-mail platforms a score of 0", () => {
    const result = computeScore(null, new Date(), "noreply@mailchimp.com");
    expect(result.score).toBe(0);
  });
  it("gives .gov addresses the highest cold-start prior", () => {
    const gov = computeScore(null, new Date(), "clerk@sfgov.gov");
    const edu = computeScore(null, new Date(), "prof@stanford.edu");
    const corp = computeScore(null, new Date(), "hello@example.com");
    expect(gov.score).toBeGreaterThan(edu.score);
    expect(edu.score).toBeGreaterThan(corp.score);
  });
});

describe("computeScore — weighted sum", () => {
  it("overall score equals the weighted component sum", () => {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    const result = computeScore(
      makeAggregate({
        replyCount: 3,
        totalReceivedFrom: 8,
        lastReplied: twoMonthsAgo,
        initiationRatio: 0.4,
      }),
    );
    const expected =
      0.5 * result.replyScore +
      0.3 * result.recencyScore +
      0.1 * result.volumeScore +
      0.1 * result.initiationScore;
    expect(result.score).toBeCloseTo(expected, 5);
  });
});
