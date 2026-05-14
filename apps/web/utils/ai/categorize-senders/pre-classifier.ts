/**
 * EL-427 — Deterministic Newsletter vs Marketing pre-classifier.
 *
 * Reads local signals (sender local-part, sender domain, recent subject
 * lines) and returns a category + confidence. Called *before* the
 * Bedrock LLM; when confidence is high the LLM call is skipped.
 *
 * This is a short-circuit, not a replacement. Ambiguous senders return
 * `{ category: null, confidence }` and fall through to Bedrock.
 *
 * Signals, in rough order of strength:
 *   1. Marketing subject patterns (urgency + promo cues) — strongest.
 *   2. Newsletter subject patterns (editorial phrasings).
 *   3. Local-part tokens (news/newsletter/digest vs deals/offers/promo).
 *   4. Brand-domain hints — downweight "newsletter" local-part when the
 *      sender is on a retail domain. This is the
 *      `newsletter@n.instant-gaming.com` edge case.
 *
 * See `pre-classifier-tokens.ts` for the lexicon.
 */

import {
  BRAND_DOMAIN_HINTS,
  MARKETING_DOMAIN_TOKENS,
  MARKETING_LOCAL_TOKENS,
  MARKETING_SUBJECT_PATTERNS,
  NEWSLETTER_DOMAIN_TOKENS,
  NEWSLETTER_LOCAL_TOKENS,
  NEWSLETTER_SUBJECT_PATTERNS,
  SCORING_WEIGHTS,
} from "./pre-classifier-tokens";

export type PreClassifierCategory = "Newsletter" | "Marketing";

export type PreClassifierInput = {
  /** Local-part of the sender email (before `@`). */
  senderLocalPart: string;
  /** Full domain of the sender (after `@`). */
  senderDomain: string;
  /** Up to N recent subject lines from this sender. */
  recentSubjects: string[];
};

export type PreClassifierResult = {
  /** Null when signals are ambiguous or insufficient. */
  category: PreClassifierCategory | null;
  /** 0..1. Numbers ≥ 0.85 are "strong enough to short-circuit Bedrock". */
  confidence: number;
  /** Optional, for debug / structured logging. Not part of the API contract. */
  signals?: {
    localNewsletterHits: string[];
    localMarketingHits: string[];
    domainNewsletterHits: string[];
    domainMarketingHits: string[];
    subjectNewsletterHits: number;
    subjectMarketingHits: number;
    brandDomainHit: boolean;
    newsletterScore: number;
    marketingScore: number;
  };
};

/** Threshold at which callers should trust the pre-classifier. */
export const PRE_CLASSIFIER_CONFIDENCE_THRESHOLD = 0.85;

function normalizeLocalPart(raw: string): string {
  return (raw ?? "").trim().toLowerCase();
}

function normalizeDomain(raw: string): string {
  return (raw ?? "").trim().toLowerCase().replace(/^@+/, "");
}

function isOnBrandDomain(domain: string): boolean {
  if (!domain) return false;
  for (const hint of BRAND_DOMAIN_HINTS) {
    // Match full domain OR any subdomain.
    if (domain === hint || domain.endsWith(`.${hint}`)) return true;
  }
  return false;
}

/**
 * Find newsletter token hits among the dot-separated labels of the
 * domain (substring match per label). Skips the public suffix (last
 * label) — `news` in `.newsroom` is not what we want.
 */
function findDomainTokenHits(
  domain: string,
  tokens: readonly string[],
): string[] {
  if (!domain) return [];
  const labels = domain.split(".");
  // Drop the public suffix label (".com", ".io", ".org", ...). We don't
  // know the full PSL, but dropping the last label is a reasonable
  // approximation and keeps us off false-positive territory like
  // `.news` TLD (rare, and even there a hit is fine).
  const head = labels.slice(0, Math.max(1, labels.length - 1));
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const label of head) {
    for (const token of tokens) {
      if (label.includes(token) && !seen.has(token)) {
        hits.push(token);
        seen.add(token);
      }
    }
  }
  return hits;
}

function findLocalPartHits(
  localPart: string,
  tokens: readonly string[],
): string[] {
  if (!localPart) return [];
  const hits: string[] = [];
  for (const token of tokens) {
    if (localPart.includes(token)) hits.push(token);
  }
  return hits;
}

function countSubjectPatternHits(
  subjects: string[],
  patterns: RegExp[],
): number {
  let hits = 0;
  for (const subject of subjects) {
    if (!subject) continue;
    for (const pattern of patterns) {
      if (pattern.test(subject)) hits++;
    }
  }
  return hits;
}

/**
 * Deterministic Newsletter vs Marketing pre-classifier. Pure function —
 * no I/O, no allocations beyond the signal record.
 */
export function preClassify(input: PreClassifierInput): PreClassifierResult {
  const localPart = normalizeLocalPart(input.senderLocalPart);
  const domain = normalizeDomain(input.senderDomain);
  const subjects = Array.isArray(input.recentSubjects)
    ? input.recentSubjects.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      )
    : [];

  const brandDomain = isOnBrandDomain(domain);

  const localNewsletterHits = findLocalPartHits(
    localPart,
    NEWSLETTER_LOCAL_TOKENS,
  );
  const localMarketingHits = findLocalPartHits(
    localPart,
    MARKETING_LOCAL_TOKENS,
  );
  const domainNewsletterHits = brandDomain
    ? [] // Don't apply newsletter-domain signals on retail brand domains.
    : findDomainTokenHits(domain, NEWSLETTER_DOMAIN_TOKENS);
  const domainMarketingHits = findDomainTokenHits(
    domain,
    MARKETING_DOMAIN_TOKENS,
  );

  const subjectNewsletterHits = countSubjectPatternHits(
    subjects,
    NEWSLETTER_SUBJECT_PATTERNS,
  );
  const subjectMarketingHits = countSubjectPatternHits(
    subjects,
    MARKETING_SUBJECT_PATTERNS,
  );

  // --- Score newsletter evidence ---
  let newsletterScore = 0;
  if (localNewsletterHits.length > 0) {
    // One newsletter token is enough — more don't compound.
    let localContribution = SCORING_WEIGHTS.LOCAL_NEWSLETTER;
    if (brandDomain) {
      // Brand domain conflict: "newsletter@n.instant-gaming.com" — the
      // local-part says newsletter but the domain says retail brand.
      // Heavily penalise.
      localContribution -= SCORING_WEIGHTS.BRAND_DOMAIN_NEWSLETTER_PENALTY;
    }
    newsletterScore += Math.max(0, localContribution);
  }
  if (domainNewsletterHits.length > 0) {
    // Domain-label match (e.g. `*@substack.com`, `*@news.gemini.com`).
    // Only one contribution regardless of token count.
    newsletterScore += SCORING_WEIGHTS.DOMAIN_NEWSLETTER;
  }
  newsletterScore += Math.min(
    SCORING_WEIGHTS.SUBJECT_CAP,
    subjectNewsletterHits * SCORING_WEIGHTS.SUBJECT_NEWSLETTER,
  );

  // --- Score marketing evidence ---
  let marketingScore = 0;
  if (localMarketingHits.length > 0) {
    marketingScore += SCORING_WEIGHTS.LOCAL_MARKETING;
  }
  if (domainMarketingHits.length > 0) {
    marketingScore += SCORING_WEIGHTS.DOMAIN_MARKETING;
  }
  marketingScore += Math.min(
    SCORING_WEIGHTS.SUBJECT_CAP,
    subjectMarketingHits * SCORING_WEIGHTS.SUBJECT_MARKETING,
  );
  if (brandDomain) {
    // Brand domain alone isn't enough, but it bumps marketing whenever
    // any other marketing evidence is present.
    if (marketingScore > 0 || subjectMarketingHits > 0) {
      marketingScore += SCORING_WEIGHTS.BRAND_DOMAIN_MARKETING_BOOST;
    }
  }

  // Clamp to [0, 1].
  newsletterScore = Math.min(1, Math.max(0, newsletterScore));
  marketingScore = Math.min(1, Math.max(0, marketingScore));

  const signals = {
    localNewsletterHits,
    localMarketingHits,
    domainNewsletterHits,
    domainMarketingHits,
    subjectNewsletterHits,
    subjectMarketingHits,
    brandDomainHit: brandDomain,
    newsletterScore,
    marketingScore,
  };

  // --- Pick winner ---
  // Confidence is the margin of the winner — it must clearly beat the
  // other category. "Both scored 0.5" means ambiguous, not tie-break.
  const MIN_MARGIN = 0.1;

  if (newsletterScore === 0 && marketingScore === 0) {
    return { category: null, confidence: 0, signals };
  }

  if (newsletterScore > marketingScore + MIN_MARGIN) {
    return {
      category: "Newsletter",
      confidence: Number(newsletterScore.toFixed(3)),
      signals,
    };
  }

  if (marketingScore > newsletterScore + MIN_MARGIN) {
    return {
      category: "Marketing",
      confidence: Number(marketingScore.toFixed(3)),
      signals,
    };
  }

  // Close race — fall through to Bedrock. Report the higher of the two
  // as raw confidence so callers can log it.
  return {
    category: null,
    confidence: Number(Math.max(newsletterScore, marketingScore).toFixed(3)),
    signals,
  };
}
