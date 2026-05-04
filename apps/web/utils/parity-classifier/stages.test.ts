/** EL-358a — ported from sidecar pipeline.test.ts (stage primitives only). */

import { describe, expect, it } from "vitest";
import { checkStage0Protected, checkStage1BulkMail } from "./stages";
import type { GmailHeaders } from "./types";

const NO_HEADERS: GmailHeaders = { messageId: "msg1" };

describe("Stage 0 — protected classes", () => {
  it("fires for the configured primary domain (ea.com default)", () => {
    const r = checkStage0Protected(
      "user@ea.com",
      "ea.com",
      false,
      false,
      "Normal email",
    );
    expect(r).not.toBeNull();
    expect(r?.reasoning).toContain("ea.com");
  });

  it("honours a caller-provided primary domain", () => {
    const r = checkStage0Protected(
      "user@acme.example",
      "acme.example",
      false,
      false,
      "hi",
      "acme.example",
    );
    expect(r).not.toBeNull();
    expect(r?.reasoning).toContain("acme.example");
  });

  it("does not fire for ea.com when primary domain is null", () => {
    const r = checkStage0Protected(
      "user@ea.com",
      "ea.com",
      false,
      false,
      "hi",
      null,
    );
    expect(r).toBeNull();
  });

  it("fires for VIP sender", () => {
    const r = checkStage0Protected(
      "vip@example.com",
      "example.com",
      true,
      false,
      "Hello",
    );
    expect(r?.reasoning).toContain("VIP");
  });

  it("fires for confirmed direct reply (In-Reply-To)", () => {
    const r = checkStage0Protected(
      "any@example.com",
      "example.com",
      false,
      true,
      "Re: hello",
    );
    expect(r?.reasoning).toContain("direct reply");
  });

  it("fires on calendar/travel subjects", () => {
    const r = checkStage0Protected(
      "any@x.com",
      "x.com",
      false,
      false,
      "Calendar invite for Monday",
    );
    expect(r?.reasoning).toContain("calendar");
  });

  it("fires on security-alert subjects", () => {
    const r = checkStage0Protected(
      "noreply@google.com",
      "google.com",
      false,
      false,
      "New sign-in to your account",
    );
    expect(r).not.toBeNull();
  });

  it("does not fire for a plain marketing email", () => {
    const r = checkStage0Protected(
      "stranger@domain.com",
      "domain.com",
      false,
      false,
      "Buy now",
    );
    expect(r).toBeNull();
  });
});

describe("Stage 2 — bulk-mail signals", () => {
  it("fires when List-Id is present", () => {
    const h: GmailHeaders = { messageId: "x", listId: "<list.example.com>" };
    expect(checkStage1BulkMail(h, false)?.reasoning).toContain("List-Id");
  });

  it("fires on RFC 8058 List-Unsubscribe-Post", () => {
    const h: GmailHeaders = {
      messageId: "x",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    };
    expect(checkStage1BulkMail(h, false)).not.toBeNull();
  });

  it("fires on Auto-Submitted: auto-generated", () => {
    const h: GmailHeaders = { messageId: "x", autoSubmitted: "auto-generated" };
    expect(checkStage1BulkMail(h, false)).not.toBeNull();
  });

  it("does NOT fire on Auto-Submitted: auto-replied (OOO)", () => {
    const h: GmailHeaders = { messageId: "x", autoSubmitted: "auto-replied" };
    expect(checkStage1BulkMail(h, false)).toBeNull();
  });

  it("uses prompt-fallback List-Unsubscribe when Gmail fetch failed", () => {
    expect(checkStage1BulkMail(NO_HEADERS, true)).not.toBeNull();
  });

  it("returns null on clean headers", () => {
    expect(checkStage1BulkMail(NO_HEADERS, false)).toBeNull();
  });
});
