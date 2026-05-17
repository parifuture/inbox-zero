import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { formatSenderRuleHiddenContext } from "./chat";

// EL-456: regression guard for the sender-rule hidden context block.
//
// Chotu reported (2026-05-17) that the AI was making up rules for
// Kickstarter without verifying anything, and when asked to search the
// inbox to confirm matches, claimed it didn't have search capability.
// `searchInbox` IS registered for this chat (see chat.ts:259) — the
// problem was the hidden-context block didn't tell the LLM to USE it.
//
// These tests lock in the grounding instructions so a future refactor
// can't silently drop them.

describe("formatSenderRuleHiddenContext (EL-449 / EL-456)", () => {
  const baseContext = {
    type: "sender-rule" as const,
    senderEmail: "no-reply@kickstarter.com",
    sampleMessages: [
      { subject: "Project funded!", snippet: "Your pledge..." },
      { subject: "New from a creator you back", snippet: "Check this out..." },
    ],
    existingLabels: ["Newsletters"],
  };

  it("locks the sender into the prompt", () => {
    const text = formatSenderRuleHiddenContext(baseContext);
    expect(text).toContain("no-reply@kickstarter.com");
    expect(text).toContain("lockedToSenderId");
    expect(text).toContain("from-condition cannot be edited later");
  });

  it("instructs the LLM to use searchInbox before drafting (EL-456)", () => {
    const text = formatSenderRuleHiddenContext(baseContext);
    expect(text).toContain("searchInbox");
    // GROUNDING anchor — explicit do-not-invent rule
    expect(text).toContain("GROUNDING REQUIREMENT");
    expect(text).toContain("do NOT invent conditions");
    // The verify-before-save instruction must explicitly tell the LLM
    // searchInbox is available, since Chotu reported the model claimed
    // it wasn't.
    expect(text).toContain("VERIFY-BEFORE-SAVE");
    expect(text).toContain("Never claim you cannot search");
  });

  it("includes a sender-scoped query template the LLM can copy", () => {
    const text = formatSenderRuleHiddenContext(baseContext);
    expect(text).toContain("from:no-reply@kickstarter.com");
  });

  it("instructs the LLM to show counts + example subjects on verification", () => {
    const text = formatSenderRuleHiddenContext(baseContext);
    expect(text.toLowerCase()).toContain("count");
    expect(text.toLowerCase()).toContain("example");
  });

  it("instructs the LLM to ask the user to refine when search returns 0", () => {
    const text = formatSenderRuleHiddenContext(baseContext);
    expect(text).toMatch(/zero matches|0 matches/i);
    expect(text).toContain("ask the user");
  });

  it("renders the sample messages and labels block", () => {
    const text = formatSenderRuleHiddenContext(baseContext);
    expect(text).toContain("Subject: Project funded!");
    expect(text).toContain("Subject: New from a creator you back");
    expect(text).toContain("Newsletters");
  });

  it("handles the empty samples / labels case gracefully", () => {
    const text = formatSenderRuleHiddenContext({
      type: "sender-rule",
      senderEmail: "x@y.com",
      sampleMessages: [],
      existingLabels: [],
    });
    expect(text).toContain("(no sample messages available)");
    expect(text).toContain("(no existing Gmail labels on this sender)");
    // Grounding instruction must still be present even with no samples.
    expect(text).toContain("searchInbox");
  });
});
