/**
 * EL-358a — deterministic policy layer (post-classification).
 *
 * Ported verbatim from sidecar `policy.ts`. Pure function mapping a
 * classifier output + scorer score to a `{ ruleName, noMatchFound }`.
 *
 * Priority order (first match wins):
 *   1. Low confidence (<0.60)           → Review
 *   2. requiresReply                    → inbox
 *   3. PERSONAL                         → inbox
 *   4. Any category + recognised label  → apply that label
 *   5. TRANSACTIONAL, no label, ≥0.30   → inbox
 *   6. TRANSACTIONAL, no label, <0.30   → Review
 *   7. BULK, no label                   → Review
 */

import type { ClassificationResult } from "./types";

export const VALID_LABELS = new Set([
  "Deliveries",
  "Finance",
  "Receipts/Food Delivery",
  "Receipts/Groceries",
  "Dev/Cloud",
  "Kickstarter",
  "Tesla",
  "DMV",
  "CryptoTax",
  "Services",
  "Newsletter",
  "Review",
]);

export function applyPolicy(
  result: ClassificationResult,
  score: number,
): { ruleName: string | null; noMatchFound: boolean } {
  const label =
    result.label && VALID_LABELS.has(result.label) ? result.label : null;

  if (result.confidence < 0.6) {
    return { ruleName: "Review", noMatchFound: false };
  }

  if (result.requiresReply) {
    return { ruleName: null, noMatchFound: true };
  }

  if (result.category === "PERSONAL") {
    return { ruleName: null, noMatchFound: true };
  }

  if (label !== null) {
    return { ruleName: label, noMatchFound: false };
  }

  if (result.category === "TRANSACTIONAL" && score >= 0.3) {
    return { ruleName: null, noMatchFound: true };
  }

  if (result.category === "TRANSACTIONAL") {
    return { ruleName: "Review", noMatchFound: false };
  }

  // BULK, no label
  return { ruleName: "Review", noMatchFound: false };
}
