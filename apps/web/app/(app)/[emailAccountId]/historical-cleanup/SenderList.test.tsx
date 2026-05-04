/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SenderList } from "./SenderList";
import type { Sender } from "./types";

(globalThis as { React?: typeof React }).React = React;

// Avoid the real LoadingContent import chain (pulls in auth/save-tokens →
// prisma → @t3-oss/env-core server-side env). We just care about rendering.
vi.mock("@/components/LoadingContent", () => ({
  LoadingContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

const baseSender = (overrides: Partial<Sender> = {}): Sender => ({
  id: "hs-1",
  senderEmail: "alice@example.com",
  senderName: "Alice",
  domain: "example.com",
  count: 12,
  firstDate: "2020-03-01T00:00:00.000Z",
  lastDate: "2023-12-31T00:00:00.000Z",
  archivedAt: null,
  skippedAt: null,
  ...overrides,
});

function renderList(overrides?: Partial<Parameters<typeof SenderList>[0]>) {
  const props = {
    senders: [baseSender()],
    isLoading: false,
    error: undefined,
    total: 1,
    search: "",
    onSearchChange: vi.fn(),
    status: "active" as const,
    onStatusChange: vi.fn(),
    sort: "count" as const,
    order: "desc" as const,
    onSortChange: vi.fn(),
    onOrderToggle: vi.fn(),
    selectedRows: new Set<string>(),
    onToggleRow: vi.fn(),
    onToggleAll: vi.fn(),
    selectedRowEmail: null,
    onSelectRow: vi.fn(),
    onArchive: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  };
  render(<SenderList {...props} />);
  return props;
}

describe("SenderList (EL-323)", () => {
  afterEach(() => cleanup());

  it("renders the sender row with email, domain, and count", () => {
    renderList();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("calls onSelectRow when a row body is clicked", () => {
    const props = renderList();
    fireEvent.click(screen.getByText("alice@example.com"));
    expect(props.onSelectRow).toHaveBeenCalled();
  });

  it("renders the emptyMessage when there are no senders and total is 0", () => {
    renderList({
      senders: [],
      total: 0,
      emptyMessage: "Run a scan first.",
    });
    expect(screen.getByText("Run a scan first.")).toBeTruthy();
  });

  it("propagates search submit to onSearchChange", () => {
    const props = renderList();
    const input = screen.getByPlaceholderText(
      /Search sender/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "foo" } });
    fireEvent.submit(input.closest("form")!);
    expect(props.onSearchChange).toHaveBeenCalledWith("foo");
  });
});
