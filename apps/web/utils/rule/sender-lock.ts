// EL-452 / EL-439: Sender-lock enforcement for rule edits.
//
// Rules created via the per-sender chat (Historical Cleanup → "Create rule
// for this sender") are permanently bound to that sender. Their `from`
// condition cannot be edited — the rule can only be deleted entirely.
// "Editing" routes back into the sender's chat surface, never the generic
// Rules-page editor.
//
// This helper detects whether a proposed patch attempts to mutate the
// from-condition of a sender-locked rule. Other fields (label name,
// action target, conditions on subject/body, enabled flag, etc.) remain
// fully editable — the lock is specifically on the from-condition.
//
// See parent EL-439 for full design context.

import { SafeError } from "@/utils/error";

export type RuleFromShape = {
  from: string | null;
  lockedToSenderId: string | null;
};

export type FromConditionPatch = {
  /** undefined = field not in patch (unchanged); null = explicit clear; string = new value */
  from?: string | null | undefined;
};

/**
 * Returns true when the patch would change the rule's `from` condition in any
 * way: replace existing value, add a new value, or clear an existing one.
 *
 * If the patch does not touch the `from` field at all (undefined), returns false.
 * If the patch sets `from` to the exact same value the rule already has,
 * returns false (no-op).
 */
export function patchTouchesFromCondition(
  rule: RuleFromShape,
  patch: FromConditionPatch,
): boolean {
  // Field not present in patch — no mutation.
  if (!Object.hasOwn(patch, "from")) return false;

  const current = rule.from ?? null;
  const next = patch.from ?? null;

  // No-op: patch sets `from` to the same value (including both null).
  if (current === next) return false;

  return true;
}

/**
 * Throws a SafeError 403 (`sender_locked`) if the rule is sender-locked AND
 * the patch attempts to mutate its from-condition.
 *
 * Returns a structured error payload via thrown SafeError so the action
 * handler / route handler returns a clean 403 the frontend can detect and
 * route the user back to the per-sender chat.
 */
export function assertNotSenderLockedFromMutation(
  rule: RuleFromShape,
  patch: FromConditionPatch,
): void {
  if (!rule.lockedToSenderId) return; // Not locked — no constraint.

  if (!patchTouchesFromCondition(rule, patch)) return; // Touches other fields only — fine.

  throw new SafeError(
    "Sender-locked rule: cannot modify from-condition. " +
      `This rule is locked to ${rule.lockedToSenderId}. ` +
      "To change its scope, edit via the per-sender chat or delete the rule.",
    403,
  );
}
