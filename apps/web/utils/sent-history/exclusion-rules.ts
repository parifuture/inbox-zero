/**
 * EL-432 — Exclusion rules for "Senders You've Replied To" bulk-archive mode.
 *
 * Pure functions. No DB / network. Token lists in this file for easy tuning.
 *
 * Rule priority (first match wins):
 *   1. vip               — `vip_senders` row matched
 *   2. active_thread     — sent-to or received-from in last 30 days
 *   3. protected_class   — banks, gov, edu, medical, legal, school
 *   4. ad_site           — craigslist, marketplace, offerup, zillow, etc.
 *   5. careers           — local-part = careers / jobs / recruiting / hr / hiring / talent / apply
 *   6. personal_domain   — gmail.com / yahoo.com / hotmail.com / icloud.com / etc.
 *
 * Anything that doesn't match returns `null` (i.e. "fine to archive").
 */

export type ExclusionReason =
  | "vip"
  | "active_thread"
  | "protected_class"
  | "ad_site"
  | "careers"
  | "personal_domain";

const ACTIVE_THREAD_WINDOW_DAYS = 30;
const ACTIVE_THREAD_WINDOW_MS = ACTIVE_THREAD_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Bank domains. Exact match; subdomain matches handled separately by domain
 * suffix check on `*.bank.com`.
 */
export const BANK_DOMAINS: ReadonlySet<string> = new Set([
  "chase.com",
  "bofa.com",
  "bankofamerica.com",
  "schwab.com",
  "fidelity.com",
  "wellsfargo.com",
  "citi.com",
  "citibank.com",
  "americanexpress.com",
  "aexp.com",
  "capitalone.com",
  "discover.com",
  "usbank.com",
  "ally.com",
  "marcus.com",
  "venmo.com",
  "paypal.com",
  "robinhood.com",
  "vanguard.com",
  "tdameritrade.com",
  "etrade.com",
  "morganstanley.com",
]);

/** Medical/insurance domains. */
export const MEDICAL_DOMAINS: ReadonlySet<string> = new Set([
  "anthem.com",
  "kaiser.org",
  "kaiserpermanente.org",
  "aetna.com",
  "cigna.com",
  "uhc.com",
  "humana.com",
  "bcbs.com",
  "blueshieldca.com",
  "myquest.com",
  "questdiagnostics.com",
  "labcorp.com",
  "cvs.com",
  "walgreens.com",
  "myfitnesspal.com",
  "onemedical.com",
]);

/** Schools relevant to Chotu's family. */
export const SCHOOL_DOMAINS: ReadonlySet<string> = new Set([
  "therenaissanceschool.org",
]);

/** Ad sites — buy/sell/rent marketplaces where one-off reply doesn't equal "real relationship". */
export const AD_SITE_DOMAINS: ReadonlySet<string> = new Set([
  "craigslist.org",
  "offerup.com",
  "nextdoor.com",
  "zillow.com",
  "apartments.com",
  "realtor.com",
  "redfin.com",
  "trulia.com",
  "hotpads.com",
  "rent.com",
]);

/** Personal-mail domains. People, not businesses — be conservative. */
export const PERSONAL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.co.uk",
  "ymail.com",
  "rocketmail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "rediffmail.com",
  "sbcglobal.net",
  "comcast.net",
  "verizon.net",
  "att.net",
  "protonmail.com",
  "proton.me",
  "pm.me",
]);

/** TLDs that are always protected (gov / edu). Suffix match. */
export const PROTECTED_TLD_SUFFIXES: readonly string[] = [
  ".gov",
  ".edu",
  ".mil",
];

/**
 * Local-part tokens that suggest a careers / hiring inbox.
 * We compare with `===` after stripping the optional `+tag` suffix.
 */
export const CAREERS_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "careers",
  "career",
  "jobs",
  "job",
  "recruiting",
  "recruit",
  "recruiter",
  "recruiters",
  "hr",
  "hiring",
  "talent",
  "talents",
  "apply",
  "applications",
  "people",
]);

/**
 * Substring tokens in a domain that indicate a law firm or legal-services
 * sender. Matched as case-insensitive substrings on the domain *root*
 * (e.g. `lawcorp.com` → matches `law`).
 */
export const LEGAL_DOMAIN_TOKENS: readonly string[] = [
  "law",
  "legal",
  "attorney",
  "lawyer",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lower(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** Strip `+tag` from local-part. `"foo+x@bar.com"` → `"foo"`. */
function localPart(email: string): string {
  const e = lower(email);
  const at = e.indexOf("@");
  if (at <= 0) return e;
  const lp = e.slice(0, at);
  const plus = lp.indexOf("+");
  return plus >= 0 ? lp.slice(0, plus) : lp;
}

function endsWith(domain: string, suffix: string): boolean {
  return domain === suffix.replace(/^\./, "") || domain.endsWith(suffix);
}

/** Match exact OR `*.suffix` for a list of root domains. */
function domainMatchesSet(domain: string, set: ReadonlySet<string>): boolean {
  if (!domain) return false;
  if (set.has(domain)) return true;
  for (const root of set) {
    if (domain.endsWith(`.${root}`)) return true;
  }
  return false;
}

function isBank(domain: string): boolean {
  return domainMatchesSet(domain, BANK_DOMAINS);
}

function isMedical(domain: string): boolean {
  return domainMatchesSet(domain, MEDICAL_DOMAINS);
}

function isSchool(domain: string): boolean {
  return domainMatchesSet(domain, SCHOOL_DOMAINS);
}

function hasProtectedTld(domain: string): boolean {
  return PROTECTED_TLD_SUFFIXES.some((s) => endsWith(domain, s));
}

function isLegal(domain: string): boolean {
  if (!domain) return false;
  // Match on the second-level domain root only — e.g. `acmelaw.com` → `acmelaw`.
  // We don't want `microsoft.com` to match because `microsoft` contains `law`?
  // It doesn't, but be careful: only match whole-word boundaries.
  const root = domain.split(".").slice(-2)[0] ?? "";
  return LEGAL_DOMAIN_TOKENS.some((t) => root.includes(t));
}

function isAdSite(domain: string): boolean {
  if (domainMatchesSet(domain, AD_SITE_DOMAINS)) return true;
  // marketplace.facebook.com, *.marketplace.facebook.com → match by literal substring on a known token
  if (
    domain === "marketplace.facebook.com" ||
    domain.endsWith(".marketplace.facebook.com")
  ) {
    return true;
  }
  return false;
}

function isPersonalDomain(domain: string): boolean {
  // Personal mail providers are exact-match only; we don't want
  // `evil.gmail.com.attacker.example` to slip through.
  return PERSONAL_DOMAINS.has(domain);
}

function isCareersLocalPart(senderEmail: string): boolean {
  const lp = localPart(senderEmail);
  return CAREERS_LOCAL_PARTS.has(lp);
}

function isActive(
  now: number,
  lastReceivedAt: Date | string | null | undefined,
  lastSentAt: Date | string | null | undefined,
): boolean {
  const candidates = [lastReceivedAt, lastSentAt]
    .map((v) => (v instanceof Date ? v : v ? new Date(v) : null))
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()));
  for (const d of candidates) {
    if (now - d.getTime() <= ACTIVE_THREAD_WINDOW_MS) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ExclusionInput = {
  senderEmail: string;
  /** Optional pre-extracted domain. If omitted, derived from `senderEmail`. */
  senderDomain?: string;
  lastReceivedAt?: Date | string | null;
  lastSentAt?: Date | string | null;
  isVip?: boolean;
  /** "Now" override for testing. Defaults to `Date.now()`. */
  now?: Date;
};

export function classifyExclusion(
  input: ExclusionInput,
): ExclusionReason | null {
  const senderEmail = lower(input.senderEmail);
  const domain = lower(input.senderDomain) || senderEmail.split("@")[1] || "";
  const now = (input.now ?? new Date()).getTime();

  // 1. VIP
  if (input.isVip === true) return "vip";

  // 2. Active thread
  if (isActive(now, input.lastReceivedAt, input.lastSentAt))
    return "active_thread";

  // 3. Protected class — banks, .gov/.edu/.mil, medical, legal, school
  if (
    hasProtectedTld(domain) ||
    isBank(domain) ||
    isMedical(domain) ||
    isLegal(domain) ||
    isSchool(domain)
  ) {
    return "protected_class";
  }

  // 4. Ad site
  if (isAdSite(domain)) return "ad_site";

  // 5. Careers / hiring inbox
  if (isCareersLocalPart(senderEmail)) return "careers";

  // 6. Personal domain
  if (isPersonalDomain(domain)) return "personal_domain";

  return null;
}

/** Stable label → user-facing copy for badges + tooltips. */
export const EXCLUSION_LABELS: Record<
  ExclusionReason,
  { badge: string; tooltip: string }
> = {
  vip: {
    badge: "vip",
    tooltip: "Marked as VIP — kept by default.",
  },
  active_thread: {
    badge: "active",
    tooltip: `You've exchanged email with this sender in the last ${ACTIVE_THREAD_WINDOW_DAYS} days.`,
  },
  protected_class: {
    badge: "protected",
    tooltip:
      "Likely bank, government, medical, legal, or school — kept by default.",
  },
  ad_site: {
    badge: "ad-site",
    tooltip:
      "Marketplace / classifieds reply — likely a one-off, not a real relationship.",
  },
  careers: {
    badge: "careers",
    tooltip: "Looks like a careers / hiring inbox.",
  },
  personal_domain: {
    badge: "personal",
    tooltip: "Personal-mail provider (likely a real person) — kept by default.",
  },
};

export const __internals = {
  ACTIVE_THREAD_WINDOW_DAYS,
  isBank,
  isMedical,
  isSchool,
  hasProtectedTld,
  isLegal,
  isAdSite,
  isPersonalDomain,
  isCareersLocalPart,
  isActive,
  localPart,
};
