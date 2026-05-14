/**
 * EL-427 — Token lists for the deterministic Newsletter vs Marketing
 * pre-classifier. Kept in a separate file so the lexicon can be updated
 * without touching the scoring module.
 *
 * Design notes:
 * - Local-part tokens match against the sender's local-part (everything
 *   before `@`), lowercased. They are matched as substrings so that
 *   `news.daily`, `daily-news`, and `dailynews` all trigger `news`/`daily`.
 * - Subject tokens are matched as case-insensitive regexes against each
 *   recent subject line. Regex form lets us anchor urgency phrases
 *   ("% off", "ends tonight", "last chance") that substring matching
 *   would under-trigger on.
 * - `BRAND_DOMAIN_HINTS` is a conservative allow-list of domain *suffixes*
 *   that strongly suggest retail / consumer-brand senders. When a sender
 *   lives on one of these domains we treat local-part tokens like
 *   "newsletter" with skepticism — the brand signal dominates. This is
 *   the `newsletter@n.instant-gaming.com` edge case from the ticket.
 */

/** Local-part tokens that suggest Newsletter. Substring match, lowercase. */
export const NEWSLETTER_LOCAL_TOKENS = [
  "news",
  "newsletter",
  "digest",
  "briefing",
  "daily",
  "weekly",
  "monthly",
  "bulletin",
  "roundup",
  "recap",
  "editor",
  "editorial",
] as const;

/** Local-part tokens that suggest Marketing. Substring match, lowercase. */
export const MARKETING_LOCAL_TOKENS = [
  "deals",
  "offers",
  "discover",
  "hello",
  "promo",
  "promotions",
  "marketing",
  "sales",
  "shop",
  "store",
  "team", // "team@brand.com" is almost always marketing
] as const;

/**
 * Subject-line signals for Newsletter. Case-insensitive regexes.
 * These are editorial / neutral phrasings — no urgency, no $ signs.
 */
export const NEWSLETTER_SUBJECT_PATTERNS: RegExp[] = [
  /\bthis week(?:'s)?\b/i,
  /\bthis month(?:'s)?\b/i,
  /\bweekly (?:digest|roundup|recap|brief(?:ing)?|newsletter|update)\b/i,
  /\bdaily (?:digest|brief(?:ing)?|news|recap|newsletter|update)\b/i,
  /\bmonthly (?:digest|recap|newsletter|update)\b/i,
  /\bissue\s*#?\s*\d+\b/i,
  /\bvol(?:ume)?\.?\s*\d+\b/i,
  /\bdigest\b/i,
  /\bbrief(?:ing)?\b/i,
  /\broundup\b/i,
  /\beditor(?:'s| pick| note)\b/i,
  /\bmorning brew\b/i,
  /\btop stor(?:y|ies)\b/i,
  /\bwhat(?:'s| is) new\b/i,
  /\byour (?:week|day|month) in\b/i,
];

/**
 * Subject-line signals for Marketing. Case-insensitive regexes.
 * Optimised for urgency + promo cues. These heavily outweigh newsletter
 * patterns when both match — a "Weekly Digest: 50% off everything" is
 * marketing, not editorial.
 */
export const MARKETING_SUBJECT_PATTERNS: RegExp[] = [
  // Discount patterns — the strongest marketing signal.
  /\d+\s*%\s*off\b/i,
  /\$\s*\d+(?:\.\d{1,2})?\s*off\b/i,
  /\bsave\s+\$\s*\d+/i,
  /\bsave\s+up\s+to\b/i,
  /\bextra\s+\d+\s*%/i,

  // Sale events.
  /\b(flash|clearance|mega|summer|winter|spring|fall|holiday|black\s*friday|cyber\s*monday|memorial\s*day|labor\s*day)\s+sale\b/i,
  /\bon\s+sale\b/i,
  /\bsale\s+ends\b/i,

  // Urgency.
  /\bends\s+(tonight|today|soon|tomorrow|in\s+\d+)/i,
  /\blast\s+chance\b/i,
  /\blimited\s+time\b/i,
  /\blimited\s+offer\b/i,
  /\btoday\s+only\b/i,
  /\bfinal\s+hours?\b/i,
  /\bhurry\b/i,
  /\bdon't\s+miss\b/i,

  // Promo currency / coupon language.
  /\bpromo\s+code\b/i,
  /\bcoupon\b/i,
  /\bexclusive\s+offer\b/i,
  /\bmember(?:s)?\s+only\b/i,
  /\bvip\s+access\b/i,
  /\bearly\s+access\b/i,

  // Product hype.
  /\bnew\s+arrivals?\b/i,
  /\bjust\s+dropped\b/i,
  /\bshop\s+now\b/i,
  /\bbuy\s+now\b/i,
  /\bfree\s+shipping\b/i,
  /\bbogo\b/i,
  /\bbuy\s+one\s+get\s+one\b/i,
];

/**
 * Domain-suffix hints for consumer / retail brand senders. When a
 * sender's domain ends with one of these, local-part tokens like
 * "newsletter" carry less weight — the sender is almost certainly a
 * brand even if they call their campaign a newsletter.
 *
 * We match against the *registered* domain (last two labels) AND the
 * full domain, so `n.instant-gaming.com` hits via `instant-gaming.com`.
 */
export const BRAND_DOMAIN_HINTS: string[] = [
  // Gaming / entertainment retail.
  "instant-gaming.com",
  "gog.com",
  "steampowered.com",
  "humblebundle.com",
  "greenmangaming.com",
  "fanatical.com",
  "epicgames.com",

  // General retail (representative — not exhaustive; edge cases fall
  // through to Bedrock, which is fine).
  "amazon.com",
  "bestbuy.com",
  "target.com",
  "walmart.com",
  "costco.com",
  "ebay.com",
  "etsy.com",
  "shopify.com",

  // Apparel / beauty (high-volume marketing senders).
  "nike.com",
  "adidas.com",
  "uniqlo.com",
  "zara.com",
  "hm.com",
  "sephora.com",
  "ulta.com",

  // Food / grocery.
  "doordash.com",
  "ubereats.com",
  "grubhub.com",
  "instacart.com",

  // Travel.
  "booking.com",
  "expedia.com",
  "airbnb.com",
  "hotels.com",
];

/**
 * Weight table — used by the scoring function. Values here are the
 * "evidence strength" of each signal and map directly into the final
 * confidence number.
 */
export const SCORING_WEIGHTS = {
  /** Newsletter local-part token, no brand-domain conflict. */
  LOCAL_NEWSLETTER: 0.45,
  /** Marketing local-part token, no brand-domain conflict. */
  LOCAL_MARKETING: 0.4,
  /** Each newsletter subject pattern match. */
  SUBJECT_NEWSLETTER: 0.25,
  /** Each marketing subject pattern match (weighted higher — urgency is a strong signal). */
  SUBJECT_MARKETING: 0.35,
  /** Brand-domain penalty applied to LOCAL_NEWSLETTER when domain looks like a retail brand. */
  BRAND_DOMAIN_NEWSLETTER_PENALTY: 0.55,
  /** Small boost when sender is on a known brand domain (favours Marketing). */
  BRAND_DOMAIN_MARKETING_BOOST: 0.2,
  /** Bound per-signal contributions. Prevents one runaway subject from pinning confidence. */
  SUBJECT_CAP: 0.6,
} as const;
