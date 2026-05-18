/**
 * EL-469 — LLM evaluator tests.
 *
 * We mock the LLM layer (`@/utils/llms` + `@/utils/llms/model`) so we
 * can drive the evaluator with deterministic decisions and verify:
 *   - schema validation
 *   - LABEL-without-labelName downgrade to SKIP
 *   - omitted messageId backfill to SKIP
 *   - unknown messageId hallucinations are dropped (warning-only)
 *   - chunk-size enforcement
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateGenerateObject, mockGetModel, mockGenerate } = vi.hoisted(
  () => ({
    mockGenerate: vi.fn(),
    mockCreateGenerateObject: vi.fn(),
    mockGetModel: vi.fn(),
  }),
);

vi.mock("@/utils/llms/model", () => ({
  getModel: mockGetModel,
}));

vi.mock("@/utils/llms", () => ({
  createGenerateObject: mockCreateGenerateObject,
}));

import {
  evaluateSenderChunk,
  MAX_EMAILS_PER_EVALUATION,
} from "@/utils/backfill/evaluator";
import type { MirrorEmailRow } from "@/utils/backfill/mirror";
import type { RuleWithRelations } from "@/utils/rule/types";

beforeEach(() => {
  mockGetModel.mockReset();
  mockCreateGenerateObject.mockReset();
  mockGenerate.mockReset();

  // Defaults — tests override per case.
  mockGetModel.mockReturnValue({ provider: "test", modelName: "test-model" });
  mockCreateGenerateObject.mockReturnValue(mockGenerate);
});

const fakeAccount = {
  id: "acct_1",
  email: "user@example.com",
  userId: "user_1",
  user: {
    aiProvider: null,
    aiModel: null,
    aiApiKey: null,
  },
  // EmailAccountWithAI carries more fields, but the evaluator only
  // touches `id`, `email`, `userId`, and `user.{aiProvider,aiModel,aiApiKey}`
  // (passed through to mocked getModel/createGenerateObject in tests).
} as unknown as Parameters<typeof evaluateSenderChunk>[0]["emailAccount"];

function fakeRule(
  overrides: Partial<RuleWithRelations> = {},
): RuleWithRelations {
  return {
    id: "rule_newsletter",
    name: "Newsletter auto-archive",
    instructions: "Archive bulk newsletters",
    actions: [{ type: "ARCHIVE", label: null }],
    enabled: true,
    runOnThreads: false,
    lockedToSenderEmail: null,
    // The rest of the RuleWithRelations fields aren't read by the
    // evaluator — cast through `unknown` so we don't need to spell out
    // the entire Prisma payload here.
    ...overrides,
  } as unknown as RuleWithRelations;
}

function fakeEmails(count: number): MirrorEmailRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    threadId: `t-${i}`,
    subject: `Email ${i}`,
    fromAddress: "newsletter@example.com",
    fromName: "Example",
    snippet: "snippet",
    bodyText: "body".repeat(100),
    labels: "INBOX",
    dateSent: new Date(2024, 0, 1 + i),
  }));
}

describe("evaluateSenderChunk", () => {
  it("returns empty array when input has no emails", async () => {
    const out = await evaluateSenderChunk({
      emailAccount: fakeAccount,
      rules: [fakeRule()],
      sender: "newsletter@example.com",
      emails: [],
    });
    expect(out).toEqual([]);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("throws when chunk size exceeds MAX_EMAILS_PER_EVALUATION", async () => {
    await expect(
      evaluateSenderChunk({
        emailAccount: fakeAccount,
        rules: [fakeRule()],
        sender: "newsletter@example.com",
        emails: fakeEmails(MAX_EMAILS_PER_EVALUATION + 1),
      }),
    ).rejects.toThrow(/exceeds MAX_EMAILS_PER_EVALUATION/);
  });

  it("returns one decision per input email when model behaves", async () => {
    const emails = fakeEmails(3);
    mockGenerate.mockResolvedValue({
      object: {
        decisions: [
          {
            messageId: "m-0",
            action: "ARCHIVE",
            ruleId: "rule_newsletter",
            reason: "newsletter",
            confidence: "high",
          },
          {
            messageId: "m-1",
            action: "ARCHIVE",
            ruleId: "rule_newsletter",
            reason: "newsletter",
            confidence: "high",
          },
          {
            messageId: "m-2",
            action: "ARCHIVE",
            ruleId: "rule_newsletter",
            reason: "newsletter",
            confidence: "high",
          },
        ],
      },
    });

    const out = await evaluateSenderChunk({
      emailAccount: fakeAccount,
      rules: [fakeRule()],
      sender: "newsletter@example.com",
      emails,
    });
    expect(out).toHaveLength(3);
    expect(out.map((d) => d.action)).toEqual(["ARCHIVE", "ARCHIVE", "ARCHIVE"]);
    expect(out.map((d) => d.messageId)).toEqual(["m-0", "m-1", "m-2"]);
  });

  it("backfills omitted messageIds with SKIP at low confidence", async () => {
    const emails = fakeEmails(3);
    mockGenerate.mockResolvedValue({
      object: {
        decisions: [
          {
            messageId: "m-0",
            action: "ARCHIVE",
            ruleId: "rule_newsletter",
            reason: "n",
            confidence: "high",
          },
          // m-1 omitted
          {
            messageId: "m-2",
            action: "TRASH",
            ruleId: "rule_newsletter",
            reason: "n",
            confidence: "medium",
          },
        ],
      },
    });

    const out = await evaluateSenderChunk({
      emailAccount: fakeAccount,
      rules: [fakeRule()],
      sender: "newsletter@example.com",
      emails,
    });
    expect(out.map((d) => d.action)).toEqual(["ARCHIVE", "SKIP", "TRASH"]);
    const skipped = out.find((d) => d.messageId === "m-1");
    expect(skipped?.confidence).toBe("low");
    expect(skipped?.reason).toMatch(/omitted/i);
    expect(skipped?.ruleId).toBeNull();
  });

  it("downgrades LABEL action without labelName to SKIP", async () => {
    const emails = fakeEmails(1);
    mockGenerate.mockResolvedValue({
      object: {
        decisions: [
          {
            messageId: "m-0",
            action: "LABEL",
            // labelName missing — schema allows it (nullable), but we
            // should treat it as a defective decision.
            ruleId: "rule_newsletter",
            reason: "should be labeled but no name",
            confidence: "high",
          },
        ],
      },
    });

    const out = await evaluateSenderChunk({
      emailAccount: fakeAccount,
      rules: [fakeRule()],
      sender: "newsletter@example.com",
      emails,
    });
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe("SKIP");
    expect(out[0].confidence).toBe("low");
    expect(out[0].reason).toMatch(/LABEL action returned without labelName/);
  });

  it("ignores hallucinated messageIds the model wasn't asked about", async () => {
    const emails = fakeEmails(1);
    mockGenerate.mockResolvedValue({
      object: {
        decisions: [
          {
            messageId: "m-0",
            action: "ARCHIVE",
            ruleId: "rule_newsletter",
            reason: "n",
            confidence: "high",
          },
          // The model hallucinated a messageId we never sent. It should
          // be dropped silently (warning-only).
          {
            messageId: "m-hallucinated",
            action: "TRASH",
            ruleId: "rule_newsletter",
            reason: "spam",
            confidence: "high",
          },
        ],
      },
    });

    const out = await evaluateSenderChunk({
      emailAccount: fakeAccount,
      rules: [fakeRule()],
      sender: "newsletter@example.com",
      emails,
    });
    expect(out).toHaveLength(1);
    expect(out[0].messageId).toBe("m-0");
  });

  it("preserves a valid LABEL decision with labelName intact", async () => {
    const emails = fakeEmails(1);
    mockGenerate.mockResolvedValue({
      object: {
        decisions: [
          {
            messageId: "m-0",
            action: "LABEL",
            labelName: "Receipts",
            ruleId: "rule_newsletter",
            reason: "matches receipt rule",
            confidence: "high",
          },
        ],
      },
    });

    const out = await evaluateSenderChunk({
      emailAccount: fakeAccount,
      rules: [fakeRule()],
      sender: "vendor@example.com",
      emails,
    });
    expect(out[0]).toMatchObject({
      action: "LABEL",
      labelName: "Receipts",
      ruleId: "rule_newsletter",
    });
  });
});
