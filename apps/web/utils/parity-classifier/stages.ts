/**
 * EL-358a — pipeline stage-check primitives.
 *
 * Ported from sidecar `pipeline.ts`. These are the small, pure predicates
 * that the 4-stage classifier uses at each gate. Keeping them broken out
 * here (instead of inline in the runner) makes them trivial to unit-test
 * and reuse from EL-358b's shadow pipeline without dragging in Gmail / DB
 * dependencies.
 */

import type { GmailHeaders, PipelineResult } from "./types";

/**
 * Subjects that trump bulk/newsletter detection. Travel + calendar +
 * security alerts are things you almost never want archived, no matter
 * what the sender looks like.
 */
const CALENDAR_PATTERN =
  /\b(calendar invite|itinerary|boarding pass|flight confirmation|hotel reservation)\b/i;
const SECURITY_PATTERN =
  /\b(login alert|new sign-in|password reset|two-factor|verification code|unusual activity)\b/i;

/**
 * Stage 0 — protected classes. If the sender or subject matches a protected
 * pattern, short-circuit straight to "keep in inbox, no rule applied". The
 * caller is responsible for translating that to whatever the host surface
 * (sidecar = noMatchFound, fork = leave SenderDecision untouched) expects.
 *
 * `emailAccountPrimaryDomain` is the owner's work/primary domain — in the
 * sidecar this was hardcoded to `ea.com`; the fork passes it in explicitly.
 */
export function checkStage0Protected(
  addrSpec: string,
  domain: string,
  isVipSender: boolean,
  isDirectReply: boolean,
  subject: string,
  emailAccountPrimaryDomain: string | null = "ea.com",
): Pick<PipelineResult, "action" | "reasoning"> | null {
  if (emailAccountPrimaryDomain && domain === emailAccountPrimaryDomain) {
    return {
      action: "inbox",
      reasoning: `${emailAccountPrimaryDomain} domain — protected class`,
    };
  }
  if (isVipSender) {
    return { action: "inbox", reasoning: `VIP sender: ${addrSpec}` };
  }
  if (isDirectReply) {
    return {
      action: "inbox",
      reasoning: "Confirmed direct reply to a sent message",
    };
  }
  if (CALENDAR_PATTERN.test(subject)) {
    return { action: "inbox", reasoning: "calendar/travel subject pattern" };
  }
  if (SECURITY_PATTERN.test(subject)) {
    return { action: "inbox", reasoning: "security alert subject pattern" };
  }
  return null;
}

/**
 * Stage 2 — bulk mail signals. RFC 2369 / RFC 8058 List headers are the
 * strongest evidence a sender is opted-in bulk mail. `Auto-Submitted:
 * auto-generated|auto-forwarded` is secondary. `auto-replied` (out-of-office
 * replies) is explicitly NOT treated as bulk because it can be a personal
 * response.
 *
 * `listUnsubscribeInPrompt` is a fallback signal from the caller's own
 * email parse when Gmail fetch was unavailable.
 */
export function checkStage1BulkMail(
  headers: GmailHeaders,
  listUnsubscribeInPrompt: boolean,
): Pick<PipelineResult, "action" | "reasoning"> | null {
  if (headers.listId) {
    return {
      action: "review",
      reasoning: `List-Id header present: ${headers.listId}`,
    };
  }
  if (headers.listUnsubscribePost) {
    return {
      action: "review",
      reasoning: "List-Unsubscribe-Post header (RFC 8058) — bulk mail",
    };
  }
  const autoSubmitted = headers.autoSubmitted?.toLowerCase();
  if (
    autoSubmitted === "auto-generated" ||
    autoSubmitted === "auto-forwarded"
  ) {
    return {
      action: "review",
      reasoning: `Auto-Submitted: ${headers.autoSubmitted}`,
    };
  }
  if (listUnsubscribeInPrompt) {
    return {
      action: "review",
      reasoning: "List-Unsubscribe header present (prompt fallback)",
    };
  }
  return null;
}
