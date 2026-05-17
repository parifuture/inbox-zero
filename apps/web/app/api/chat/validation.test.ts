import { describe, it, expect } from "vitest";
import {
  messageContextSchema,
  senderRuleContextSchema,
  fixRuleContextSchema,
} from "./validation";

// EL-449: discriminated-union message context for the assistant chat.
// `fix-rule` is the existing per-email-fix flow; `sender-rule` is the new
// per-sender chat surface for Historical Cleanup (EL-439). The lock on the
// sender is enforced in the schema (required `senderEmail`) and downstream
// in the chat hidden-context block (do-not-broaden instruction) + EL-452 on
// the API side.

describe("messageContextSchema", () => {
  it("accepts a valid sender-rule context", () => {
    const parsed = messageContextSchema.parse({
      type: "sender-rule",
      senderEmail: "service@paypal.com",
      sampleMessages: [
        { subject: "Receipt for $10", snippet: "You sent $10 to..." },
        { subject: "Statement is ready", snippet: "Your monthly..." },
      ],
      existingLabels: ["Finance", "Receipts"],
    });

    expect(parsed.type).toBe("sender-rule");
    if (parsed.type !== "sender-rule") return;
    expect(parsed.senderEmail).toBe("service@paypal.com");
    expect(parsed.sampleMessages).toHaveLength(2);
    expect(parsed.existingLabels).toEqual(["Finance", "Receipts"]);
  });

  it("accepts a sender-rule with no samples or labels", () => {
    const parsed = messageContextSchema.parse({
      type: "sender-rule",
      senderEmail: "noreply@example.com",
      sampleMessages: [],
      existingLabels: [],
    });

    expect(parsed.type).toBe("sender-rule");
  });

  it("rejects sender-rule with an invalid email", () => {
    expect(() =>
      messageContextSchema.parse({
        type: "sender-rule",
        senderEmail: "not-an-email",
        sampleMessages: [],
        existingLabels: [],
      }),
    ).toThrow();
  });

  it("rejects sender-rule with too many sample messages", () => {
    const samples = Array.from({ length: 51 }, (_, i) => ({
      subject: `Subject ${i}`,
      snippet: `Snippet ${i}`,
    }));

    expect(() =>
      messageContextSchema.parse({
        type: "sender-rule",
        senderEmail: "x@y.com",
        sampleMessages: samples,
        existingLabels: [],
      }),
    ).toThrow();
  });

  it("rejects sender-rule with too many existing labels", () => {
    const labels = Array.from({ length: 101 }, (_, i) => `Label-${i}`);

    expect(() =>
      messageContextSchema.parse({
        type: "sender-rule",
        senderEmail: "x@y.com",
        sampleMessages: [],
        existingLabels: labels,
      }),
    ).toThrow();
  });

  it("still accepts the existing fix-rule shape (backwards-compatible)", () => {
    const parsed = messageContextSchema.parse({
      type: "fix-rule",
      message: {
        id: "m1",
        threadId: "t1",
        snippet: "...",
        headers: {
          from: "a@b.com",
          to: "me@me.com",
          subject: "hi",
          date: "2026-05-17",
        },
      },
      results: [],
      expected: "new",
    });

    expect(parsed.type).toBe("fix-rule");
  });

  it("rejects an unknown context type", () => {
    expect(() =>
      messageContextSchema.parse({
        type: "totally-made-up",
        foo: "bar",
      }),
    ).toThrow();
  });

  it("rejects a sender-rule that includes fix-rule fields (no leakage across variants)", () => {
    // The discriminator strictly switches on `type`; extra fields are ignored
    // by zod by default but the required fields for sender-rule must still be
    // present. Missing senderEmail must throw even if fix-rule fields are set.
    expect(() =>
      messageContextSchema.parse({
        type: "sender-rule",
        // no senderEmail
        sampleMessages: [],
        existingLabels: [],
        message: { id: "x" },
        results: [],
        expected: "new",
      }),
    ).toThrow();
  });
});

describe("senderRuleContextSchema (direct)", () => {
  it("parses the canonical shape", () => {
    const parsed = senderRuleContextSchema.parse({
      type: "sender-rule",
      senderEmail: "billing@stripe.com",
      sampleMessages: [{ subject: "Invoice", snippet: "Due now" }],
      existingLabels: ["Finance"],
    });

    expect(parsed.senderEmail).toBe("billing@stripe.com");
  });
});

describe("fixRuleContextSchema (direct)", () => {
  it("still parses the legacy fix-rule shape", () => {
    const parsed = fixRuleContextSchema.parse({
      type: "fix-rule",
      message: {
        id: "m1",
        threadId: "t1",
        snippet: "snip",
        headers: {
          from: "a@b.com",
          to: "me@me.com",
          subject: "hi",
          date: "2026-05-17",
        },
      },
      results: [],
      expected: "none",
    });

    expect(parsed.type).toBe("fix-rule");
  });
});
