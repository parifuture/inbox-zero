/**
 * EL-358b \u2014 runner unit tests.
 *
 * We mock Prisma, kill-switch, and the Bedrock classifier so the runner
 * can be exercised deterministically. The pure-stage primitives already
 * have their own coverage (stages/domains/scorer/policy tests) so we
 * focus on orchestration: stage selection, kill-switch gating, feature
 * flags, and the shape of the persisted row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedMessage } from "@/utils/types";
import type { SenderAggregate } from "./types";

vi.mock("server-only", () => ({}));

vi.mock("@/utils/prisma", () => {
  const prisma = {
    senderDecision: { findUnique: vi.fn() },
    emailMessage: { findFirst: vi.fn() },
    parityDecision: { upsert: vi.fn() },
  };
  return { default: prisma };
});
vi.mock("@/utils/kill-switch", () => ({
  isAutonomousPaused: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/utils/ai/content-sanitizer", () => ({
  emailToContentForAI: vi.fn(() => "body content"),
}));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));

vi.mock("@/env", () => ({
  env: {
    PARITY_SHADOW_ENABLED: true,
    PARITY_SHADOW_BEDROCK_ENABLED: false,
    PARITY_PRIMARY_DOMAIN: "ea.com",
  },
}));

import { runParityPipeline, persistParityDecision } from "./runner";
import prisma from "@/utils/prisma";
import { isAutonomousPaused } from "@/utils/kill-switch";

const ACCOUNT = {
  id: "acc_123",
  email: "me@example.com",
  userId: "user_1",
  user: { aiProvider: null, aiModel: null, aiApiKey: null },
} as const;

function buildMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: "msg_1",
    threadId: "thread_1",
    date: new Date().toISOString(),
    historyId: "h1",
    inline: [],
    snippet: "",
    subject: "Hello",
    headers: {
      date: new Date().toISOString(),
      from: "stranger@random.com",
      subject: "Hello",
      to: "me@example.com",
    },
    ...overrides,
  } as ParsedMessage;
}

const AGG_ZERO: SenderAggregate = {
  address: "stranger@random.com",
  domain: "random.com",
  firstSeen: null,
  initiationRatio: 0.5,
  lastReceived: null,
  lastReplied: null,
  replyCount: 0,
  totalReceivedFrom: 0,
  totalSentToThem: 0,
};

describe("runParityPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.senderDecision.findUnique as any).mockResolvedValue(null);
    (prisma.emailMessage.findFirst as any).mockResolvedValue(null);
    (isAutonomousPaused as any).mockResolvedValue(false);
  });

  it("stage 0: primary-domain sender returns inbox", async () => {
    const result = await runParityPipeline({
      emailAccount: ACCOUNT,
      message: buildMessage({
        headers: {
          date: new Date().toISOString(),
          from: "coworker@ea.com",
          subject: "lunch",
          to: "me@example.com",
        },
      }),
    });
    expect(result.stage).toBe(0);
    expect(result.action).toBe("inbox");
    expect(result.reasoning).toContain("ea.com");
  });

  it("stage 0: auto_trash sender short-circuits", async () => {
    (prisma.senderDecision.findUnique as any).mockResolvedValue({
      action: "auto_trash",
    });
    const result = await runParityPipeline({
      emailAccount: ACCOUNT,
      message: buildMessage({
        headers: {
          date: new Date().toISOString(),
          from: "spam@evil.biz",
          subject: "buy now",
          to: "me@example.com",
        },
      }),
    });
    expect(result.stage).toBe(0);
    expect(result.action).toBe("trash");
    expect(result.ruleName).toBeNull();
  });

  it("stage 0: always_keep sender is treated as VIP", async () => {
    (prisma.senderDecision.findUnique as any).mockResolvedValue({
      action: "always_keep",
    });
    const result = await runParityPipeline({
      emailAccount: ACCOUNT,
      message: buildMessage({
        headers: {
          date: new Date().toISOString(),
          from: "mom@family.net",
          subject: "call me",
          to: "me@example.com",
        },
      }),
    });
    expect(result.stage).toBe(0);
    expect(result.action).toBe("inbox");
    expect(result.reasoning).toContain("VIP");
  });

  it("stage 1: known marketing domain returns trash intent (no mutation)", async () => {
    const result = await runParityPipeline({
      emailAccount: ACCOUNT,
      message: buildMessage({
        headers: {
          date: new Date().toISOString(),
          from: "news@kickstarter.com",
          subject: "project update",
          to: "me@example.com",
        },
      }),
    });
    expect(result.stage).toBe(1);
    expect(result.ruleName).toBe("Kickstarter");
  });

  it("stage 2: list-unsubscribe header promotes to Newsletter review", async () => {
    const result = await runParityPipeline({
      emailAccount: ACCOUNT,
      message: buildMessage({
        headers: {
          date: new Date().toISOString(),
          from: "hello@unknowndomain.io",
          subject: "digest",
          to: "me@example.com",
          "list-unsubscribe": "<mailto:u@x>",
        },
      }),
    });
    expect(result.stage).toBe(2);
    expect(result.action).toBe("review");
    expect(result.ruleName).toBe("Newsletter");
  });

  it("stage 3: cold-start free-mail stranger routes to Review", async () => {
    // gmail.com is a free-email provider → domain prior 0.1 ≤ 0.15 threshold
    // and it's not in DOMAIN_RULES, so we fall through to stage 3 cleanly.
    const result = await runParityPipeline({
      emailAccount: ACCOUNT,
      message: buildMessage({
        headers: {
          date: new Date().toISOString(),
          from: "stranger@gmail.com",
          subject: "hi there",
          to: "me@example.com",
        },
      }),
      buildAggregate: async () => null,
    });
    expect(result.stage).toBe(3);
    expect(result.action).toBe("review");
    expect(result.ruleName).toBe("Review");
  });

  it("stage 3: heavy reply history routes to Inbox", async () => {
    const result = await runParityPipeline({
      emailAccount: ACCOUNT,
      message: buildMessage(),
      buildAggregate: async () => ({
        ...AGG_ZERO,
        replyCount: 12,
        totalReceivedFrom: 25,
        initiationRatio: 0.1,
        lastReplied: new Date(),
      }),
    });
    expect(result.stage).toBe(3);
    expect(result.action).toBe("inbox");
  });

  it("stage 4: skipped when kill-switch engaged, even for mid-score senders", async () => {
    (isAutonomousPaused as any).mockResolvedValue(true);
    const result = await runParityPipeline({
      emailAccount: ACCOUNT,
      message: buildMessage(),
      buildAggregate: async () => ({
        ...AGG_ZERO,
        replyCount: 2,
        totalReceivedFrom: 3,
        initiationRatio: 0.4,
        lastReplied: new Date(Date.now() - 90 * 24 * 3_600_000),
      }),
    });
    expect(result.stage).toBe(4);
    expect(result.reasoning).toContain("skipped_by_kill_switch");
    expect(result.bedrockUsed).toBe(false);
  });

  it("stage 4: skipped when bedrock flag off, falls back to Review", async () => {
    const result = await runParityPipeline({
      emailAccount: ACCOUNT,
      message: buildMessage(),
      buildAggregate: async () => ({
        ...AGG_ZERO,
        replyCount: 2,
        totalReceivedFrom: 3,
        initiationRatio: 0.4,
        lastReplied: new Date(Date.now() - 90 * 24 * 3_600_000),
      }),
    });
    expect(result.stage).toBe(4);
    expect(result.action).toBe("review");
    expect(result.reasoning).toContain("stage4_disabled_by_flag");
  });

  it("stage 4: bedrock classifier result flows through policy", async () => {
    // Force mid-score so we hit stage 4.
    const classify = vi.fn().mockResolvedValue({
      category: "TRANSACTIONAL",
      label: "Finance",
      requiresReply: false,
      confidence: 0.85,
      reasoning: "looks like a bank alert",
    });
    // Re-import env to flip the flag for this test only \u2014 since we
    // mocked `@/env` at module-top with a literal object, we just
    // toggle the field.
    const envModule = await import("@/env");
    (envModule.env as any).PARITY_SHADOW_BEDROCK_ENABLED = true;
    try {
      const result = await runParityPipeline({
        emailAccount: ACCOUNT,
        message: buildMessage(),
        buildAggregate: async () => ({
          ...AGG_ZERO,
          replyCount: 2,
          totalReceivedFrom: 3,
          initiationRatio: 0.4,
          lastReplied: new Date(Date.now() - 90 * 24 * 3_600_000),
        }),
        classify,
      });
      expect(classify).toHaveBeenCalledOnce();
      expect(result.stage).toBe(4);
      expect(result.bedrockUsed).toBe(true);
      expect(result.ruleName).toBe("Finance");
      expect(result.category).toBe("TRANSACTIONAL");
    } finally {
      (envModule.env as any).PARITY_SHADOW_BEDROCK_ENABLED = false;
    }
  });
});

describe("persistParityDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts the observability row with core fields populated", async () => {
    await persistParityDecision({
      emailAccountId: "acc_1",
      message: buildMessage({
        id: "m_42",
        threadId: "t_42",
        headers: {
          date: new Date().toISOString(),
          from: "Bank <alerts@bankofamerica.com>",
          subject: "Your statement is ready",
          to: "me@example.com",
        },
      }),
      result: {
        stage: 1,
        action: "review",
        ruleName: "Finance",
        reasoning: "Known domain: bankofamerica.com \u2192 finance",
        bedrockUsed: false,
        gmailFetchFailed: false,
      },
      durationMs: 17,
      score: null,
      confidence: null,
    });

    expect(prisma.parityDecision.upsert).toHaveBeenCalledOnce();
    const arg = (prisma.parityDecision.upsert as any).mock.calls[0][0];
    expect(arg.where.emailAccountId_messageId).toEqual({
      emailAccountId: "acc_1",
      messageId: "m_42",
    });
    expect(arg.create.senderEmail).toBe("alerts@bankofamerica.com");
    expect(arg.create.senderDomain).toBe("bankofamerica.com");
    expect(arg.create.stage).toBe(1);
    expect(arg.create.action).toBe("review");
    expect(arg.create.ruleName).toBe("Finance");
  });
});
