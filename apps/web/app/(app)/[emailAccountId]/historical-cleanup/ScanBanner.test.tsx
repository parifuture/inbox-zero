/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanBanner } from "./ScanBanner";

(globalThis as { React?: typeof React }).React = React;

const mockUseScanStatus = vi.fn();
const mockUseStartScan = vi.fn();

vi.mock("./hooks", () => ({
  useScanStatus: (...args: unknown[]) => mockUseScanStatus(...args),
  useStartScan: () => mockUseStartScan,
}));

describe("ScanBanner (EL-323)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseStartScan.mockImplementation(() => Promise.resolve());
  });
  afterEach(() => cleanup());

  it("renders idle CTA when no scan exists", () => {
    mockUseScanStatus.mockReturnValue({
      data: { status: "idle" },
      mutate: vi.fn(),
      isLoading: false,
    });
    render(<ScanBanner />);
    expect(screen.getByRole("button", { name: /Scan inbox/i })).toBeTruthy();
  });

  it("shows progress and messages processed while running", () => {
    mockUseScanStatus.mockReturnValue({
      data: {
        status: "running",
        progress: 1500,
        totalEstimate: 5000,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        cutoffDate: "2024-01-01T00:00:00.000Z",
        id: "scan-1",
      },
      mutate: vi.fn(),
      isLoading: false,
    });
    render(<ScanBanner />);
    expect(screen.getByText(/Scanning inbox/)).toBeTruthy();
    expect(screen.getByText("1,500")).toBeTruthy();
    expect(screen.getByText("5,000")).toBeTruthy();
  });

  it("renders error state with retry when scan failed", () => {
    mockUseScanStatus.mockReturnValue({
      data: {
        status: "error",
        progress: 0,
        totalEstimate: null,
        error: "Gmail 429",
        startedAt: null,
        completedAt: null,
        cutoffDate: "2024-01-01T00:00:00.000Z",
        id: "scan-err",
      },
      mutate: vi.fn(),
      isLoading: false,
    });
    render(<ScanBanner />);
    expect(screen.getByText(/Scan failed/)).toBeTruthy();
    expect(screen.getByText(/Gmail 429/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry scan/i })).toBeTruthy();
  });

  it("renders completion summary with re-scan button", () => {
    mockUseScanStatus.mockReturnValue({
      data: {
        status: "completed",
        progress: 8237,
        totalEstimate: 8237,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        cutoffDate: "2024-01-01T00:00:00.000Z",
        id: "scan-done",
      },
      mutate: vi.fn(),
      isLoading: false,
    });
    render(<ScanBanner />);
    expect(screen.getByText(/Scan complete/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Re-scan/i })).toBeTruthy();
  });

  it("kicks off the scan when the CTA is clicked", () => {
    const mutate = vi.fn();
    mockUseScanStatus.mockReturnValue({
      data: { status: "idle" },
      mutate,
      isLoading: false,
    });
    render(<ScanBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Scan inbox/i }));
    expect(mockUseStartScan).toHaveBeenCalled();
  });
});
