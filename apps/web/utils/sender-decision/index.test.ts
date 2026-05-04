import { describe, expect, it } from "vitest";
import { canonicalizeSender } from "./index";

describe("canonicalizeSender", () => {
  it("extracts a bare email and lowercases it", () => {
    expect(canonicalizeSender("A@Domain.COM")).toBe("a@domain.com");
  });

  it("extracts from a display-name + angle-bracket form", () => {
    expect(canonicalizeSender('"Jane Doe" <Jane.Doe@Example.com>')).toBe(
      "jane.doe@example.com",
    );
  });

  it("strips +tag addressing", () => {
    expect(canonicalizeSender('"Name" <A+tag@Domain.COM>')).toBe(
      "a@domain.com",
    );
  });

  it("strips +tag with only a plus character", () => {
    expect(canonicalizeSender("alice+@example.com")).toBe("alice@example.com");
  });

  it("handles leading/trailing whitespace", () => {
    expect(canonicalizeSender("  hello@World.org  ")).toBe("hello@world.org");
  });

  it("returns empty string for invalid input", () => {
    expect(canonicalizeSender("")).toBe("");
    expect(canonicalizeSender("not-an-email")).toBe("");
    expect(canonicalizeSender("@bad.com")).toBe("");
    expect(canonicalizeSender("bad@")).toBe("");
  });

  it("keeps subdomains intact", () => {
    expect(canonicalizeSender("Bot <Bot@mail.Notifications.Linear.app>")).toBe(
      "bot@mail.notifications.linear.app",
    );
  });

  it("preserves dot-local-parts (Gmail dots are not normalized)", () => {
    // We deliberately DO NOT strip dots — Gmail treats foo.bar@ == foobar@,
    // but other providers do not. Leave as-is for provider-agnostic safety.
    expect(canonicalizeSender("foo.bar@example.com")).toBe(
      "foo.bar@example.com",
    );
  });
});
