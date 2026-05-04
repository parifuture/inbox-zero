/**
 * EL-358a — deterministic domain → category routing (Stage 1).
 *
 * Ported verbatim from sidecar `domains.ts`. Pure lookup: no DB, no I/O.
 * The table grows organically as senders are audited; every addition
 * should ship with a one-line justification in the commit.
 */

export type DomainCategory =
  | "kickstarter"
  | "finance"
  | "delivery"
  | "receipt-food-delivery"
  | "receipt-groceries"
  | "school"
  | "tesla"
  | "dmv"
  | "legal-vauld"
  | "legal-celsius"
  | "legal-solar"
  | "cryptotax"
  | "dev-cloud"
  | "receipt"
  | "newsletter"
  | "marketing";

interface DomainRule {
  category: DomainCategory;
  domains: string[]; // exact domain matches (lowercased)
  substrings?: string[]; // substring matches in the full addr-spec
}

export const DOMAIN_RULES: DomainRule[] = [
  { domains: ["kickstarter.com"], category: "kickstarter" },

  {
    domains: [
      "paypal.com",
      "paypal.co",
      "bankofamerica.com",
      "bofa.com",
      "morganstanley.com",
      "coinbase.com",
      "applecard.apple",
      "post.applecard.apple",
      "bayareafastrak.org",
      "email.informeddelivery.usps.com",
      "equifax.com",
      "verify.secureemail@equifax.com",
      "equifaxbreachsettlement.com",
      "mint.intuit.com",
      "em1.mint.intuit.com",
      "vsp.com",
      "e.vsp.com",
      "reliancematrix.com",
    ],
    substrings: ["fastrak", "apple.card"],
    category: "finance",
  },

  {
    domains: [
      "fedex.com",
      "ups.com",
      "upsemail.com",
      "usps.com",
      "email.informeddelivery.usps.com",
      "dhl.com",
      "amazon.com",
      "amazonlogistics.com",
      "narvar.com",
      "aftership.com",
      "route.com",
      "mail.route.com",
      "ontrac.com",
      "lasership.com",
      "shippingagent.com",
      "jetkvm.com",
      "g2g.com",
      "levainbakery.com",
    ],
    substrings: ["shipping", "shipment", "delivery", "tracking", "narvar.com"],
    category: "delivery",
  },

  {
    domains: ["therenaissanceschool.org", "schoolcues.com"],
    category: "school",
  },

  {
    domains: [
      "tesla.com",
      "teslainsuranceservices.com",
      "reply.teslainsuranceservices.com",
    ],
    category: "tesla",
  },

  { domains: ["dmv.ca.gov"], category: "dmv" },

  {
    domains: ["vauld.com", "apps.kroll.com", "defipaymentsschememanager.com"],
    substrings: ["kroll.com", "defi.payment"],
    category: "legal-vauld",
  },

  // celsiusnetwork.com = PHISHING (real Celsius used celsius.network only)
  {
    domains: ["celsius.network", "cases.stretto.com"],
    substrings: ["celsius.network"],
    category: "legal-celsius",
  },

  {
    domains: ["sunergycorp.com", "servicetitan.com"],
    category: "legal-solar",
  },

  { domains: ["cryptotaxgirl.com"], category: "cryptotax" },

  {
    domains: [
      "google.com",
      "googleaistudio-noreply.google.com",
      "cloud.google.com",
      "aws.amazon.com",
      "amazonaws.com",
      "vercel.com",
      "github.com",
      "github.io",
      "netlify.com",
      "render.com",
      "heroku.com",
      "digitalocean.com",
      "anthropic.com",
      "openai.com",
      "huggingface.co",
    ],
    substrings: ["googleaistudio", "noreply@post.applecard"],
    category: "dev-cloud",
  },

  {
    domains: [
      "ubereats.com",
      "doordash.com",
      "trycaviar.com",
      "grubhub.com",
      "seamless.com",
      "postmates.com",
      "chownow.com",
    ],
    category: "receipt-food-delivery",
  },

  // Grocery receipts intentionally NOT domain-routed — mixed-content senders.

  {
    domains: [
      "paddle.com",
      "stripe.com",
      "shopify.com",
      "etsy.com",
      "ebay.com",
      "dominos.com",
      "orders.dominos.com",
      "stamps.com",
      "recreation.gov",
      "setapp.com",
      "marriott.com",
      "airbnb.com",
    ],
    substrings: ["receipt", "order-confirm", "your-order", "purchase-confirm"],
    category: "receipt",
  },

  {
    domains: [
      "tldrnewsletter.com",
      "substack.com",
      "mailchimp.com",
      "beehiiv.com",
      "convertkit.com",
      "buttondown.email",
      "bookclubs.com",
      "m.bookclubs.com",
      "buildspace.so",
      "sfbags.com",
    ],
    category: "newsletter",
  },

  {
    domains: ["oldnavy.com", "email.oldnavy.com", "gap.com", "moviepass.com"],
    category: "marketing",
  },
];

export const CATEGORY_RULE_NAMES: Record<DomainCategory, string> = {
  kickstarter: "Kickstarter",
  finance: "Finance",
  delivery: "Delivery",
  "receipt-food-delivery": "Receipts — Food Delivery",
  "receipt-groceries": "Receipts — Groceries",
  school: "School",
  tesla: "Tesla",
  dmv: "DMV",
  "legal-vauld": "Legal — Vauld",
  "legal-celsius": "Legal — Celsius",
  "legal-solar": "Legal — Solar",
  cryptotax: "CryptoTax",
  "dev-cloud": "Dev/Cloud",
  receipt: "Receipt",
  newsletter: "Newsletter",
  marketing: "Marketing",
};

export function lookupDomainCategory(
  addrSpec: string,
  domain: string,
): DomainCategory | null {
  const lowerAddr = addrSpec.toLowerCase();
  const lowerDomain = domain.toLowerCase();

  for (const rule of DOMAIN_RULES) {
    if (rule.domains.some((d) => d.toLowerCase() === lowerDomain)) {
      return rule.category;
    }
    if (rule.substrings?.some((s) => lowerAddr.includes(s.toLowerCase()))) {
      return rule.category;
    }
  }
  return null;
}
