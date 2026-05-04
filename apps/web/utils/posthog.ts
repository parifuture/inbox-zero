/**
 * Server-side PostHog shim for self-hosted fork.
 *
 * The original module emitted analytics events via `posthog-node`. In the
 * self-hosted single-user fork we do not phone home, so every exported
 * function is a no-op that preserves the original signature. Call sites stay
 * unchanged and compile cleanly.
 *
 * See EL-359 — telemetry strip.
 */

import type { Properties } from "@/utils/posthog-client";

/** No-op — we never construct a real PostHog client. */
export function getPosthogLlmClient(): undefined {
  return;
}

export function isPosthogLlmEvalApproved(_email: string): boolean {
  return false;
}

export async function deletePosthogUser(_options: { email: string }) {
  /* no-op */
}

export async function aliasPosthogUser(_opts: {
  oldEmail: string;
  newEmail: string;
}) {
  /* no-op */
}

export async function posthogCaptureEvent(
  _email: string,
  _event: string,
  _properties?: Record<string, unknown>,
  _sendFeatureFlags?: boolean,
) {
  /* no-op */
}

export async function trackUserSignedUp(_email: string, _createdAt: Date) {
  /* no-op */
}

export async function trackStripeCustomerCreated(
  _email: string,
  _stripeCustomerId: string,
) {
  /* no-op */
}

export async function trackStripeCheckoutCreated(
  _email: string,
  _properties?: Properties,
) {
  /* no-op */
}

export async function trackStripeCheckoutCompleted(
  _email: string,
  _properties?: Properties,
) {
  /* no-op */
}

export async function trackError(_args: {
  email: string;
  emailAccountId: string;
  errorType: string;
  type: "api" | "action";
  url: string;
}) {
  /* no-op */
}

export async function trackTrialStarted(_email: string, _attributes: any) {
  /* no-op */
}

export async function trackUpgradedToPremium(_email: string, _attributes: any) {
  /* no-op */
}

export async function trackSubscriptionTrialStarted(
  _email: string,
  _attributes: any,
) {
  /* no-op */
}

export async function trackBillingTrialStarted(
  _email: string,
  _attributes: Properties,
) {
  /* no-op */
}

export async function trackSubscriptionCustom(
  _email: string,
  _status: string,
  _attributes: any,
) {
  /* no-op */
}

export async function trackSubscriptionStatusChanged(
  _email: string,
  _attributes: any,
) {
  /* no-op */
}

export async function trackSubscriptionCancelled(
  _email: string,
  _status: string,
  _attributes: any,
) {
  /* no-op */
}

export async function trackSwitchedPremiumPlan(
  _email: string,
  _status: string,
  _attributes: any,
) {
  /* no-op */
}

export async function trackPaymentSuccess(_args: {
  email: string;
  totalPaidUSD: number | undefined;
  lemonSqueezyId: string;
  lemonSqueezyType: string;
}) {
  /* no-op */
}

export async function trackStripeEvent(_email: string, _data: any) {
  /* no-op */
}

export async function trackUserDeleted(_userId: string) {
  /* no-op */
}

export const FIRST_TIME_EVENTS = {
  FIRST_AUTOMATED_RULE_RUN: "First automated rule run",
  FIRST_DRAFT_SENT: "First AI draft sent",
  FIRST_CHAT_MESSAGE: "First chat message",
} as const;

type FirstTimeEvent =
  (typeof FIRST_TIME_EVENTS)[keyof typeof FIRST_TIME_EVENTS];

export async function trackFirstTimeEvent(_args: {
  emailAccountId: string;
  event: FirstTimeEvent;
  properties?: Record<string, unknown>;
}) {
  /* no-op */
}

export async function trackOnboardingAnswer(
  _email: string,
  _answers: {
    surveyFeatures?: string[];
    surveyRole?: string;
    surveyGoal?: string;
    surveyCompanySize?: number;
    surveySource?: string;
    surveyImprovements?: string;
  },
) {
  /* no-op */
}
