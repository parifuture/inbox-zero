/**
 * EL-358a — personal-priority scorer (Stage 3).
 *
 * Ported verbatim from sidecar `scorer.ts`. Pure function: given a
 * `SenderAggregate` (or null for cold-start), returns a 0-1 score plus
 * a breakdown of the weighted components.
 *
 *   0.5 × replyScore      — have you replied? (primary signal)
 *   0.3 × recencyScore    — exponential decay by days since last reply
 *   0.1 × volumeScore     — total emails received from this sender
 *   0.1 × initiationScore — do THEY reach out (not just you)
 */

import type { ScoreResult, SenderAggregate } from "./types";

export const INBOX_THRESHOLD = 0.5;
export const REVIEW_THRESHOLD = 0.15;

const FREE_EMAIL_PROVIDERS = new Set([
  "gmail.com",
  "hotmail.com",
  "yahoo.com",
  "outlook.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "proton.me",
  "aol.com",
  "msn.com",
  "live.com",
]);

const BULK_MAIL_PLATFORMS = new Set([
  "mailchimp.com",
  "sendgrid.net",
  "klaviyo.com",
  "constantcontact.com",
  "mailgun.org",
  "sparkpost.com",
  "amazonses.com",
  "exacttarget.com",
  "salesforce.com",
  "marketo.net",
  "hubspot.com",
  "customer.io",
]);

function getDomainPrior(address: string): number {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  if (BULK_MAIL_PLATFORMS.has(domain)) return 0.0;
  if (FREE_EMAIL_PROVIDERS.has(domain)) return 0.1;
  if (domain.endsWith(".edu")) return 0.25;
  if (domain.endsWith(".gov")) return 0.3;
  return 0.2; // default: unknown corporate domain
}

export function computeScore(
  agg: SenderAggregate | null,
  now: Date = new Date(),
  address?: string,
): ScoreResult {
  if (!agg) {
    if (!address) {
      return {
        score: 0,
        source: "no_data",
        replyCount: 0,
        daysSinceLastReply: null,
        totalReceived: 0,
        initiationRatio: 0.5,
        replyScore: 0,
        recencyScore: 0,
        volumeScore: 0,
        initiationScore: 0,
      };
    }
    const prior = getDomainPrior(address);
    return {
      score: prior,
      source: "domain_prior",
      replyCount: 0,
      daysSinceLastReply: null,
      totalReceived: 0,
      initiationRatio: 0.5,
      replyScore: 0,
      recencyScore: prior,
      volumeScore: 0,
      initiationScore: 0,
    };
  }

  // reply_score: 0 replies → 0.0, 10+ replies → 1.0
  const replyScore = Math.min(agg.replyCount, 10) / 10;

  // recency_score: exponential decay — 0 days → 1.0, 180d → 0.37, 365d → 0.13
  let recencyScore = 0;
  let daysSinceLastReply: number | null = null;
  if (agg.lastReplied) {
    daysSinceLastReply =
      (now.getTime() - agg.lastReplied.getTime()) / (1000 * 60 * 60 * 24);
    recencyScore = Math.exp(-daysSinceLastReply / 180);
  }

  // volume_score: 0 → 0.0, 20+ → 1.0
  const volumeScore = Math.min(agg.totalReceivedFrom, 20) / 20;

  // initiation_score: they initiate more (ratio → 0) → 1.0; you initiate → 0.0
  const initiationScore = 1 - agg.initiationRatio;

  const score = Math.min(
    Math.max(
      0.5 * replyScore +
        0.3 * recencyScore +
        0.1 * volumeScore +
        0.1 * initiationScore,
      0,
    ),
    1,
  );

  return {
    score,
    source: "history",
    replyCount: agg.replyCount,
    daysSinceLastReply,
    totalReceived: agg.totalReceivedFrom,
    initiationRatio: agg.initiationRatio,
    replyScore,
    recencyScore,
    volumeScore,
    initiationScore,
  };
}
