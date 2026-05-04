import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/env", () => ({
  env: {
    NODE_ENV: "test",
  },
}));

vi.mock("@/utils/redis", () => ({
  redis: {
    set: vi.fn(),
  },
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: { findUnique: vi.fn() },
  },
}));

import {
  FIRST_TIME_EVENTS,
  trackFirstTimeEvent,
  posthogCaptureEvent,
  getPosthogLlmClient,
} from "./posthog";
import { redis } from "@/utils/redis";

// EL-359 telemetry strip: all posthog helpers are no-ops in the self-hosted
// fork. These tests confirm no upstream side effects (no Redis writes, no
// Prisma reads, no client construction).
describe("posthog (no-op shim)", () => {
  it("getPosthogLlmClient returns undefined", () => {
    expect(getPosthogLlmClient()).toBeUndefined();
  });

  it("posthogCaptureEvent resolves without touching Redis", async () => {
    await posthogCaptureEvent("user@example.com", "test-event", { a: 1 });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("trackFirstTimeEvent resolves without touching Redis", async () => {
    await trackFirstTimeEvent({
      emailAccountId: "acct-1",
      event: FIRST_TIME_EVENTS.FIRST_CHAT_MESSAGE,
    });
    expect(redis.set).not.toHaveBeenCalled();
  });
});
