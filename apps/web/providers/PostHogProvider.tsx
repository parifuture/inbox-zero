"use client";

/**
 * PostHog provider — no-op passthrough for self-hosted fork.
 *
 * Originally booted `posthog-js` in the browser and emitted pageviews /
 * identity. In the self-hosted fork we don't ship client analytics, so this
 * module keeps the same exports but every component is a passthrough.
 *
 * See EL-359 — telemetry strip.
 */

export function PostHogPageview() {
  return null;
}

export function PostHogIdentify() {
  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  return children as React.ReactElement;
}
