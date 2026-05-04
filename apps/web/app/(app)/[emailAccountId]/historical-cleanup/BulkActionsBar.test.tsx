/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkActionsBar } from "./BulkActionsBar";

(globalThis as { React?: typeof React }).React = React;

describe("BulkActionsBar (EL-323 confirmation modal)", () => {
  afterEach(() => cleanup());

  it("renders nothing when no senders are selected", () => {
    const { container } = render(
      <BulkActionsBar
        selectedSenders={[]}
        onArchive={() => {}}
        onSkip={() => {}}
        onClear={() => {}}
        isWorking={false}
      />,
    );
    expect(container.textContent?.trim()).toBe("");
  });

  it("shows selection count and total thread estimate on the bar", () => {
    render(
      <BulkActionsBar
        selectedSenders={[
          { senderEmail: "a@x.com", count: 3 },
          { senderEmail: "b@x.com", count: 7 },
        ]}
        onArchive={() => {}}
        onSkip={() => {}}
        onClear={() => {}}
        isWorking={false}
      />,
    );
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText(/~10 threads/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Archive Selected \(2\)/ }),
    ).toBeTruthy();
  });

  it("does NOT call onArchive until the confirmation dialog is confirmed", () => {
    const onArchive = vi.fn();
    render(
      <BulkActionsBar
        selectedSenders={[{ senderEmail: "a@x.com", count: 4 }]}
        onArchive={onArchive}
        onSkip={() => {}}
        onClear={() => {}}
        isWorking={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Archive Selected/ }));
    expect(onArchive).not.toHaveBeenCalled();

    // Dialog now visible — title shows total thread count.
    expect(screen.getByText(/Archive ~4 thread/i)).toBeTruthy();
    // Sample senders list includes the selection.
    expect(screen.getByText("a@x.com")).toBeTruthy();
    // Safety-filter line is present so the user knows sent + trash are off-limits.
    expect(screen.getByText(/in:sent/)).toBeTruthy();
    expect(screen.getByText(/in:trash/)).toBeTruthy();

    // Confirm button carries the exact count.
    fireEvent.click(screen.getByRole("button", { name: /Archive 4 thread/ }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("cancelling the dialog never calls onArchive", () => {
    const onArchive = vi.fn();
    render(
      <BulkActionsBar
        selectedSenders={[{ senderEmail: "a@x.com", count: 4 }]}
        onArchive={onArchive}
        onSkip={() => {}}
        onClear={() => {}}
        isWorking={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Archive Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("shows '…and N more' when more than 5 senders are selected", () => {
    const senders = Array.from({ length: 8 }, (_, i) => ({
      senderEmail: `s${i}@x.com`,
      count: 1,
    }));
    render(
      <BulkActionsBar
        selectedSenders={senders}
        onArchive={() => {}}
        onSkip={() => {}}
        onClear={() => {}}
        isWorking={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Archive Selected/ }));
    expect(screen.getByText(/and 3 more/i)).toBeTruthy();
  });
});
