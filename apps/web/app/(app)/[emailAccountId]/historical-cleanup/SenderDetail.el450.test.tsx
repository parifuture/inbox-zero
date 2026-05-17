/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { React?: typeof React }).React = React;

// EL-450 unit tests focus on the new "Create rule for this sender" button +
// deep-link auto-open behavior in SenderDetail. We mock every dependency
// that pulls in server-side env (auth, prisma, etc.) and stub useChat /
// useSidebar / useSenderMessages so we can observe what gets seeded.

const setOpenSpy = vi.fn();
const setContextSpy = vi.fn();
const setInputSpy = vi.fn();
const setNewChatSpy = vi.fn();

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ setOpen: setOpenSpy }),
}));

vi.mock("@/providers/ChatProvider", () => ({
  useChat: () => ({
    setContext: setContextSpy,
    setInput: setInputSpy,
    setNewChat: setNewChatSpy,
  }),
}));

vi.mock("@/components/LoadingContent", () => ({
  LoadingContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

const useSenderMessagesMock = vi.fn();
vi.mock("./hooks", () => ({
  useSenderMessages: (...args: unknown[]) => useSenderMessagesMock(...args),
}));

import { SenderDetail } from "./SenderDetail";
import type { Sender } from "./types";

const baseSender = (overrides: Partial<Sender> = {}): Sender => ({
  id: "hs-1",
  senderEmail: "service@paypal.com",
  senderName: "PayPal",
  domain: "paypal.com",
  count: 42,
  firstDate: "2020-03-01T00:00:00.000Z",
  lastDate: "2023-12-31T00:00:00.000Z",
  archivedAt: null,
  skippedAt: null,
  deletedAt: null,
  ...overrides,
});

const baseMessage = (overrides: Record<string, unknown> = {}) => ({
  id: "m1",
  threadId: "t1",
  date: "2026-05-01T12:00:00.000Z",
  subject: "Receipt for $10",
  snippet: "You sent $10 to Alice",
  labelState: "inbox" as const,
  inbox: true,
  ...overrides,
});

function setupHookData(
  data: { messages: ReturnType<typeof baseMessage>[] } | null,
) {
  useSenderMessagesMock.mockReturnValue({
    data: data
      ? {
          ...data,
          nextPageToken: null,
          fromCache: false,
          fetchedAt: "2026-05-17T17:00:00.000Z",
          partial: false,
        }
      : undefined,
    error: null,
    isLoading: !data,
    isValidating: false,
    mutate: vi.fn(),
  });
}

afterEach(() => {
  cleanup();
  setOpenSpy.mockReset();
  setContextSpy.mockReset();
  setInputSpy.mockReset();
  setNewChatSpy.mockReset();
  useSenderMessagesMock.mockReset();
});

describe("SenderDetail — Create rule for this sender (EL-450)", () => {
  it("renders the Create rule for this sender button when a sender is selected", () => {
    setupHookData({ messages: [baseMessage()] });
    render(
      <SenderDetail
        sender={baseSender()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        isArchiving={false}
        isDeleting={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: /create rule for this sender/i }),
    ).toBeTruthy();
  });

  it("does NOT render the Create rule button when no sender is selected", () => {
    setupHookData(null);
    render(
      <SenderDetail
        sender={null}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        isArchiving={false}
        isDeleting={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /create rule for this sender/i }),
    ).toBeNull();
  });

  it("seeds ChatProvider with a sender-rule context and opens the chat sidebar on click", () => {
    setupHookData({
      messages: [
        baseMessage({ subject: "Receipt 1", snippet: "snip 1" }),
        baseMessage({
          id: "m2",
          subject: "Receipt 2",
          snippet: "snip 2",
          labelState: "archived",
        }),
      ],
    });
    render(
      <SenderDetail
        sender={baseSender()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        isArchiving={false}
        isDeleting={false}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /create rule for this sender/i }),
    );

    expect(setNewChatSpy).toHaveBeenCalledOnce();
    expect(setContextSpy).toHaveBeenCalledOnce();
    const ctx = setContextSpy.mock.calls[0][0];
    expect(ctx.type).toBe("sender-rule");
    expect(ctx.senderEmail).toBe("service@paypal.com");
    expect(ctx.sampleMessages).toHaveLength(2);
    expect(ctx.sampleMessages[0]).toEqual({
      subject: "Receipt 1",
      snippet: "snip 1",
    });
    // labelState dedup
    expect(ctx.existingLabels.sort()).toEqual(["archived", "inbox"]);
    expect(setInputSpy).toHaveBeenCalledOnce();
    expect(setInputSpy.mock.calls[0][0]).toContain("service@paypal.com");
    expect(setOpenSpy).toHaveBeenCalledOnce();
  });

  it("caps sampleMessages at 20 even if the sender has more", () => {
    const messages = Array.from({ length: 35 }, (_, i) =>
      baseMessage({ id: `m${i}`, subject: `S${i}`, snippet: `snip${i}` }),
    );
    setupHookData({ messages });
    render(
      <SenderDetail
        sender={baseSender()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        isArchiving={false}
        isDeleting={false}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /create rule for this sender/i }),
    );
    const ctx = setContextSpy.mock.calls[0][0];
    expect(ctx.sampleMessages).toHaveLength(20);
  });

  it("auto-opens the chat when autoOpenChatForSenderEmail matches the selected sender (deep-link)", () => {
    setupHookData({ messages: [baseMessage()] });
    render(
      <SenderDetail
        sender={baseSender({ senderEmail: "billing@stripe.com" })}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        isArchiving={false}
        isDeleting={false}
        autoOpenChatForSenderEmail="billing@stripe.com"
      />,
    );

    // Effect should have fired once messages are present.
    expect(setContextSpy).toHaveBeenCalledOnce();
    const ctx = setContextSpy.mock.calls[0][0];
    expect(ctx.type).toBe("sender-rule");
    expect(ctx.senderEmail).toBe("billing@stripe.com");
  });

  it("does NOT auto-open the chat when autoOpenChatForSenderEmail mismatches", () => {
    setupHookData({ messages: [baseMessage()] });
    render(
      <SenderDetail
        sender={baseSender({ senderEmail: "billing@stripe.com" })}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        isArchiving={false}
        isDeleting={false}
        autoOpenChatForSenderEmail="someone-else@example.com"
      />,
    );

    expect(setContextSpy).not.toHaveBeenCalled();
    expect(setOpenSpy).not.toHaveBeenCalled();
  });

  it("does NOT auto-open until at least one message is loaded (avoids empty seed)", () => {
    setupHookData(null);
    const { rerender } = render(
      <SenderDetail
        sender={baseSender({ senderEmail: "billing@stripe.com" })}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        isArchiving={false}
        isDeleting={false}
        autoOpenChatForSenderEmail="billing@stripe.com"
      />,
    );

    expect(setContextSpy).not.toHaveBeenCalled();

    // Now data arrives.
    setupHookData({ messages: [baseMessage()] });
    rerender(
      <SenderDetail
        sender={baseSender({ senderEmail: "billing@stripe.com" })}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        isArchiving={false}
        isDeleting={false}
        autoOpenChatForSenderEmail="billing@stripe.com"
      />,
    );

    expect(setContextSpy).toHaveBeenCalledOnce();
  });
});
