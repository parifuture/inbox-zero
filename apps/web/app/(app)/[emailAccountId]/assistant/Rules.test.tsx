/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemType } from "@/generated/prisma/enums";

const mockUseRules = vi.fn();
const mockUseAccount = vi.fn();
const mockUseLabels = vi.fn();
const mockUseDialogState = vi.fn();
const mockSetOpen = vi.fn();
const mockSetInput = vi.fn();
const mockExecuteAsync = vi.fn();

(globalThis as { React?: typeof React }).React = React;

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/hooks/useRules", () => ({
  useRules: () => mockUseRules(),
}));

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => mockUseAccount(),
}));

vi.mock("@/hooks/useLabels", () => ({
  useLabels: () => mockUseLabels(),
}));

vi.mock("@/hooks/useDialogState", () => ({
  useDialogState: () => mockUseDialogState(),
}));

vi.mock("@/providers/ChatProvider", () => ({
  useChat: () => ({ setInput: mockSetInput }),
}));

vi.mock("@/env", () => ({
  env: new Proxy(
    {},
    {
      get: () => "",
    },
  ),
}));

vi.mock("@/utils/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ setOpen: mockSetOpen }),
}));

vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ executeAsync: mockExecuteAsync }),
}));

vi.mock("./RuleDialog", () => ({
  RuleDialog: () => null,
}));

import { Rules } from "./Rules";

afterEach(() => {
  cleanup();
});

describe("Rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseRules.mockReturnValue({
      data: [
        {
          id: "system-rule-1",
          name: "Newsletter",
          instructions: "Auto-organize newsletters",
          enabled: true,
          runOnThreads: false,
          automate: true,
          actions: [],
          group: null,
          emailAccountId: "ea_1",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          updatedAt: new Date("2026-03-01T00:00:00.000Z"),
          categoryFilterType: null,
          conditionalOperator: "OR",
          groupId: null,
          systemType: SystemType.NEWSLETTER,
          to: null,
          from: null,
          subject: null,
          body: null,
          promptText: null,
          lockedToSenderId: null,
        },
        {
          id: "custom-rule-1",
          name: "Custom rule",
          instructions: "Handle a specific sender",
          enabled: true,
          runOnThreads: true,
          automate: true,
          actions: [],
          group: null,
          emailAccountId: "ea_1",
          createdAt: new Date("2026-03-02T00:00:00.000Z"),
          updatedAt: new Date("2026-03-02T00:00:00.000Z"),
          categoryFilterType: null,
          conditionalOperator: "OR",
          groupId: null,
          systemType: null,
          to: null,
          from: null,
          subject: null,
          body: null,
          promptText: null,
          lockedToSenderId: null,
        },
        {
          id: "locked-rule-1",
          name: "PayPal receipts",
          instructions: "Keep receipts, trash everything else",
          enabled: true,
          runOnThreads: false,
          automate: true,
          actions: [],
          group: null,
          emailAccountId: "ea_1",
          createdAt: new Date("2026-05-16T00:00:00.000Z"),
          updatedAt: new Date("2026-05-16T00:00:00.000Z"),
          categoryFilterType: null,
          conditionalOperator: "AND",
          groupId: null,
          systemType: null,
          to: null,
          from: "paypal.com",
          subject: null,
          body: null,
          promptText: null,
          lockedToSenderId: "paypal.com",
        },
      ],
      isLoading: false,
      error: null,
      mutate: vi.fn(),
    });

    mockUseAccount.mockReturnValue({
      emailAccountId: "ea_1",
      provider: "google",
    });
    mockUseLabels.mockReturnValue({ userLabels: [] });
    mockUseDialogState.mockReturnValue({
      data: undefined,
      isOpen: false,
      onOpen: vi.fn(),
      onClose: vi.fn(),
    });
  });

  it("hides delete for default rules", () => {
    render(<Rules />);

    const newsletterRow = screen.getByText("Newsletter").closest("tr");
    expect(newsletterRow).toBeTruthy();

    fireEvent.pointerDown(
      within(newsletterRow as HTMLElement).getByRole("button", {
        name: "Toggle menu",
      }),
      { button: 0, ctrlKey: false },
    );

    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("still shows delete for custom rules", () => {
    render(<Rules />);

    const customRuleRow = screen.getByText("Custom rule").closest("tr");
    expect(customRuleRow).toBeTruthy();

    fireEvent.pointerDown(
      within(customRuleRow as HTMLElement).getByRole("button", {
        name: "Toggle menu",
      }),
      { button: 0, ctrlKey: false },
    );

    expect(screen.getByText("Delete")).toBeTruthy();
  });

  // EL-453: Sender-locked rule affordance

  it("renders the lock indicator next to a sender-locked rule's name", () => {
    render(<Rules />);

    const lockedRow = screen.getByText("PayPal receipts").closest("tr");
    expect(lockedRow).toBeTruthy();
    expect(
      within(lockedRow as HTMLElement).getByTestId("sender-lock-indicator"),
    ).toBeTruthy();
  });

  it("does NOT render the lock indicator on un-locked rules", () => {
    render(<Rules />);

    const customRuleRow = screen.getByText("Custom rule").closest("tr");
    expect(customRuleRow).toBeTruthy();
    expect(
      within(customRuleRow as HTMLElement).queryByTestId(
        "sender-lock-indicator",
      ),
    ).toBeNull();
  });

  it("replaces Edit-manually + Edit-via-AI with a single sender-locked link on locked rules", () => {
    render(<Rules />);

    const lockedRow = screen.getByText("PayPal receipts").closest("tr");
    expect(lockedRow).toBeTruthy();

    fireEvent.pointerDown(
      within(lockedRow as HTMLElement).getByRole("button", {
        name: "Toggle menu",
      }),
      { button: 0, ctrlKey: false },
    );

    // Locked rules show the sender-locked link
    const lockedLink = screen.getByText(/Edit in paypal\.com chat/i);
    expect(lockedLink).toBeTruthy();

    // Locked rules do NOT show the standard Edit-manually / Edit-via-AI items
    expect(screen.queryByText("Edit manually")).toBeNull();
    expect(screen.queryByText("Edit via AI")).toBeNull();
  });

  it("sender-locked link routes to /historical-cleanup with the sender + openChat=true", () => {
    render(<Rules />);

    const lockedRow = screen.getByText("PayPal receipts").closest("tr");
    expect(lockedRow).toBeTruthy();

    fireEvent.pointerDown(
      within(lockedRow as HTMLElement).getByRole("button", {
        name: "Toggle menu",
      }),
      { button: 0, ctrlKey: false },
    );

    const lockedLinkText = screen.getByText(/Edit in paypal\.com chat/i);
    const linkElement = lockedLinkText.closest("a");
    const href = linkElement?.getAttribute("href") || "";
    expect(href).toContain("/historical-cleanup");
    expect(href).toContain("sender=paypal.com");
    expect(href).toContain("openChat=true");
  });

  it("sender-locked link tooltip explains the lock", () => {
    render(<Rules />);

    const lockedRow = screen.getByText("PayPal receipts").closest("tr");
    fireEvent.pointerDown(
      within(lockedRow as HTMLElement).getByRole("button", {
        name: "Toggle menu",
      }),
      { button: 0, ctrlKey: false },
    );

    // The tooltip lives on the DropdownMenuItem wrapper (parent of the link)
    const lockedLinkText = screen.getByText(/Edit in paypal\.com chat/i);
    // Walk up the DOM to find an ancestor with a title attribute
    let node: HTMLElement | null = lockedLinkText;
    while (node && !node.getAttribute("title")) {
      node = node.parentElement;
    }
    expect(node?.getAttribute("title")).toContain("per-sender chat");
  });

  it("unlocked custom rules still show the standard Edit-manually + Edit-via-AI items", () => {
    render(<Rules />);

    const customRuleRow = screen.getByText("Custom rule").closest("tr");
    fireEvent.pointerDown(
      within(customRuleRow as HTMLElement).getByRole("button", {
        name: "Toggle menu",
      }),
      { button: 0, ctrlKey: false },
    );

    expect(screen.getByText("Edit manually")).toBeTruthy();
    expect(screen.getByText("Edit via AI")).toBeTruthy();
    expect(screen.queryByText(/Edit in .* chat/i)).toBeNull();
  });

  it("locked rules still show Delete (deletion is the only allowed scope-changing op)", () => {
    render(<Rules />);

    const lockedRow = screen.getByText("PayPal receipts").closest("tr");
    fireEvent.pointerDown(
      within(lockedRow as HTMLElement).getByRole("button", {
        name: "Toggle menu",
      }),
      { button: 0, ctrlKey: false },
    );

    expect(screen.getByText("Delete")).toBeTruthy();
  });
});
