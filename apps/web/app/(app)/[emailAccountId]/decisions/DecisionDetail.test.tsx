/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionDetail } from "@/app/(app)/[emailAccountId]/decisions/DecisionDetail";

(globalThis as { React?: typeof React }).React = React;

// Minimal SWR mock — no network
vi.mock("swr", () => ({
  default: () => ({
    data: null,
    error: null,
    isLoading: false,
    mutate: vi.fn(),
  }),
}));

vi.mock("@/components/Toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/app/(app)/[emailAccountId]/decisions/DecisionHistoryPanel", () => ({
  DecisionHistoryPanel: () => null,
}));

vi.mock("@/components/LoadingContent", () => ({
  LoadingContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// Use native select so we can fireEvent.change — simpler than Radix portals.
vi.mock("@/components/ui/select", () => {
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => {
    // Flatten children to find items + trigger aria-label.
    const items: React.ReactElement[] = [];
    let ariaLabel: string | undefined;
    const walk = (node: React.ReactNode) => {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement(child)) return;
        const el = child as React.ReactElement<any>;
        const disp = (el.type as any)?.displayName;
        if (disp === "SelectItem") {
          items.push(el);
        } else if (disp === "SelectTrigger") {
          if (el.props?.["aria-label"]) ariaLabel = el.props["aria-label"];
          if (el.props?.children) walk(el.props.children);
        } else if (el.props?.children) {
          walk(el.props.children);
        }
      });
    };
    walk(children);
    return (
      <select
        aria-label={ariaLabel}
        data-testid="select"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {items.map((it) => (
          <option key={(it.props as any).value} value={(it.props as any).value}>
            {(it.props as any).children}
          </option>
        ))}
      </select>
    );
  };
  const SelectItem = ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => <option value={value}>{children}</option>;
  (SelectItem as any).displayName = "SelectItem";
  const SelectTrigger = ({ children }: any) => <>{children}</>;
  (SelectTrigger as any).displayName = "SelectTrigger";
  return {
    Select,
    SelectItem,
    SelectContent: ({ children }: any) => <>{children}</>,
    SelectTrigger,
    SelectValue: () => null,
  };
});

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: any) => <>{children}</>,
  DialogContent: ({ children }: any) => <>{children}</>,
  DialogHeader: ({ children }: any) => <>{children}</>,
  DialogTitle: ({ children }: any) => <>{children}</>,
  DialogDescription: ({ children }: any) => <>{children}</>,
  DialogFooter: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: (p: any) => <button {...p}>{p.children}</button>,
}));
vi.mock("@/components/ui/input", () => ({
  Input: (p: any) => <input {...p} />,
}));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: (p: any) => <input type="checkbox" {...p} />,
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
}));
vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: any) => <table>{children}</table>,
  TableBody: ({ children }: any) => <tbody>{children}</tbody>,
  TableCell: ({ children }: any) => <td>{children}</td>,
  TableHead: ({ children }: any) => <th>{children}</th>,
  TableHeader: ({ children }: any) => <thead>{children}</thead>,
  TableRow: ({ children }: any) => <tr>{children}</tr>,
}));

afterEach(() => cleanup());

function makeDecision(overrides: any = {}) {
  return {
    id: "d1",
    emailAccountId: "ea1",
    senderEmail: "news@example.com",
    senderDomain: "example.com",
    action: "always_keep",
    source: "user",
    note: null,
    messageCount: 0,
    autoAppliedAt: null,
    keepLabelId: null,
    keepLabelName: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

const labels = [
  { id: "l1", gmailLabelId: "Label_1", name: "Newsletter" },
  { id: "l2", gmailLabelId: "Label_2", name: "Receipts" },
] as any;

describe("DecisionDetail — keep-label picker", () => {
  it("does not render label picker when action is not always_keep", () => {
    render(
      <DecisionDetail
        decision={makeDecision({ action: "auto_trash" })}
        labels={labels}
        onActionChange={() => {}}
        onKeepLabelChange={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Keep label")).toBeNull();
  });

  it("renders label picker for always_keep and fires onKeepLabelChange with id + name", () => {
    const onKeepLabelChange = vi.fn();
    render(
      <DecisionDetail
        decision={makeDecision()}
        labels={labels}
        onActionChange={() => {}}
        onKeepLabelChange={onKeepLabelChange}
      />,
    );

    const picker = screen.getByLabelText("Keep label") as HTMLSelectElement;
    expect(picker).toBeTruthy();

    fireEvent.change(picker, { target: { value: "Label_2" } });
    expect(onKeepLabelChange).toHaveBeenCalledWith("Label_2", "Receipts");

    fireEvent.change(picker, { target: { value: "__none" } });
    expect(onKeepLabelChange).toHaveBeenLastCalledWith(null, null);
  });
});
