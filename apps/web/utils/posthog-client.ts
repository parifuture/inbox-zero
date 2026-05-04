"use client";

/**
 * Client-side PostHog shim for self-hosted fork.
 *
 * All exports preserve the surface of `posthog-js` and `posthog-js/react` so
 * existing call sites compile unchanged, but every function is a no-op. This
 * keeps the single-user self-hosted fork from phoning home.
 *
 * See EL-359 — telemetry strip.
 */

import type React from "react";

// Minimal shape matching `posthog-js` PostHog class — only the members we use.
export type PostHog = {
  capture: (event: string, properties?: Record<string, unknown>) => void;
  identify: (distinctId?: string, properties?: Record<string, unknown>) => void;
  register: (properties: Record<string, unknown>) => void;
  setPersonProperties: (
    set?: Record<string, unknown>,
    setOnce?: Record<string, unknown>,
  ) => void;
  init: (key: string, config?: Record<string, unknown>) => void;
  alias: (opts: { distinctId: string; alias: string }) => void;
  updateEarlyAccessFeatureEnrollment: (
    featureKey: string,
    enrolled: boolean,
  ) => void;
  getEarlyAccessFeatures: (
    cb?: (features: EarlyAccessFeature[]) => void,
    _force?: boolean,
    _stages?: string[],
  ) => EarlyAccessFeature[];
  getFeatureFlag: (key: string) => string | boolean | undefined;
};

export type EarlyAccessFeature = {
  flagKey: string;
  name: string;
  description?: string;
  stage?: string;
  documentationUrl?: string;
};

// `posthog-js` exports `Properties` as a type alias for arbitrary property bags.
export type Properties = Record<string, unknown>;

const noop = () => {
  /* no-op */
};

/** Default export equivalent of `import posthog from "@/utils/posthog-client"`. */
const posthog: PostHog = {
  capture: noop,
  identify: noop,
  register: noop,
  setPersonProperties: noop,
  init: noop,
  alias: noop,
  updateEarlyAccessFeatureEnrollment: noop,
  getEarlyAccessFeatures: (cb) => {
    if (cb) cb([]);
    return [];
  },
  getFeatureFlag: () => undefined,
};

export default posthog;

// React-side surface (`posthog-js/react`)

/** Provider wrapper — passes children through untouched. */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  return children as React.ReactElement;
}

/** Hook — always returns the no-op PostHog stub. */
export function usePostHog(): PostHog {
  return posthog;
}

/** Always returns false — no feature flags in the self-hosted fork. */
export function useFeatureFlagEnabled(_key: string): boolean | undefined {
  return;
}

/** Always returns undefined — no A/B variants in the self-hosted fork. */
export function useFeatureFlagVariantKey(
  _key: string,
): string | boolean | undefined {
  return;
}

/** Always returns an empty list — no active feature flags. */
export function useActiveFeatureFlags(): string[] {
  return [];
}
