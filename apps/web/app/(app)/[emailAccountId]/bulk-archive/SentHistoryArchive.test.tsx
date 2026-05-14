/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

(globalThis as { React?: typeof React }).React = React;

// Avoid LoadingContent → server-side env import.
vi.mock("@/components/LoadingContent", () => ({
  LoadingContent: ({
    children,
    loading,
    error,
  }: {
    children: React.ReactNode;
    loading?: boolean;
    error?: unknown;
  }) => {
    if (loading) return <div data-testid="loading">loading…</div>;
    if (error) return <div data-testid="error">error</div>;
    return <>{children}</>;
  },
}));

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "ea-1" }),
}));

const fetchMock = vi.fn();
vi.mock("@/utils/fetch", () => ({
  fetchWithAccount: (...args: unknown[]) => fetchMock(...args),
}));

// Toast is sometimes loaded via window/global; stub it to a noop with success/error.
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import { SentHistoryArchive } from "./SentHistoryArchive";
import type {
  SentHistoryResponse,
  SentHistorySender,
} from "@/app/api/historical-senders/sent-history/route";

function makeSender(
  overrides: Partial<SentHistorySender> = {},
): SentHistorySender {
  return {
    senderEmail: "x@example.com",
    senderDomain: "example.com",
    senderName: null,
    sentToThemCount: 1,
    lastSentToThem: null,
    lastReceivedFrom: null,
    receivedCount: 5,
    category: null,
    exclusionReason: null,
    excluded: false,
    ...overrides,
  };
}

function makeResponse(
  senders: SentHistorySender[],
  killSwitchPaused = false,
): SentHistoryResponse {
  const willKeep = senders.filter((s) => s.excluded).length;
  return {
    senders,
    totals: {
      candidates: senders.length,
      willArchive: senders.length - willKeep,
      willKeep,
      byReason: {
        vip: 0,
        active_thread: 0,
        protected_class: 0,
        ad_site: 0,
        careers: 0,
        personal_domain: 0,
      },
    },
    killSwitchPaused,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withSWR(node: React.ReactNode) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {node}
    </SWRConfig>
  );
}

describe("SentHistoryArchive (EL-432)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });
  afterEach(() => cleanup());

  it("renders both sections with the right counts when senders load", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makeResponse([
          makeSender({ senderEmail: "a@somecorp.com", receivedCount: 10 }),
          makeSender({
            senderEmail: "b@gmail.com",
            senderDomain: "gmail.com",
            exclusionReason: "personal_domain",
            excluded: true,
          }),
        ]),
      ),
    );

    render(withSWR(<SentHistoryArchive />));
    await waitFor(() => {
      expect(screen.getByText(/Will archive \(1\)/i)).toBeTruthy();
    });
    expect(screen.getByText(/Will keep \(1\)/i)).toBeTruthy();
    expect(screen.getByText("a@somecorp.com")).toBeTruthy();
    expect(screen.getByText("b@gmail.com")).toBeTruthy();
    // Bottom-bar archive button reflects the count
    expect(
      screen.getByRole("button", { name: /Archive 1 senders/i }),
    ).toBeTruthy();
  });

  it("renders the kill-switch paused banner and disables Archive when paused", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(makeResponse([makeSender()], /* paused */ true)),
    );
    render(withSWR(<SentHistoryArchive />));
    await waitFor(() => {
      expect(screen.getByText(/Autonomous actions are paused/i)).toBeTruthy();
    });
    const archiveButton = screen.getByRole("button", {
      name: /Archive 1 senders/i,
    }) as HTMLButtonElement;
    expect(archiveButton.disabled).toBe(true);
  });

  it("moves a row from 'Will archive' to 'Will keep' when the per-row button is clicked", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makeResponse([makeSender({ senderEmail: "movable@biz.com" })]),
      ),
    );
    render(withSWR(<SentHistoryArchive />));
    await waitFor(() => {
      expect(screen.getByText("movable@biz.com")).toBeTruthy();
    });
    expect(screen.getByText(/Will archive \(1\)/i)).toBeTruthy();
    const moveBtn = screen.getByLabelText(/Move to keep for movable@biz.com/i);
    fireEvent.click(moveBtn);
    await waitFor(() => {
      expect(screen.getByText(/Will keep \(1\)/i)).toBeTruthy();
    });
    expect(screen.getByText(/Will archive \(0\)/i)).toBeTruthy();
  });

  it("filters via the search input", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makeResponse([
          makeSender({ senderEmail: "alpha@biz.com" }),
          makeSender({ senderEmail: "beta@biz.com" }),
        ]),
      ),
    );
    render(withSWR(<SentHistoryArchive />));
    await waitFor(() => {
      expect(screen.getByText("alpha@biz.com")).toBeTruthy();
    });
    const searchInput = screen.getByPlaceholderText(
      /Search senders/i,
    ) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "alpha" } });
    await waitFor(() => {
      expect(screen.queryByText("beta@biz.com")).toBeNull();
    });
    expect(screen.getByText("alpha@biz.com")).toBeTruthy();
  });

  it("posts senderEmails + excludeSenderEmails on archive click", async () => {
    fetchMock
      // 1st: GET initial list
      .mockResolvedValueOnce(
        jsonResponse(
          makeResponse([
            makeSender({ senderEmail: "good@biz.com" }),
            makeSender({
              senderEmail: "personal@gmail.com",
              senderDomain: "gmail.com",
              exclusionReason: "personal_domain",
              excluded: true,
            }),
          ]),
        ),
      )
      // 2nd: POST archive
      .mockResolvedValueOnce(
        jsonResponse({
          archived: [{ senderEmail: "good@biz.com", count: 5 }],
          excluded: 1,
        }),
      )
      // 3rd: SWR re-fetch after mutate()
      .mockResolvedValueOnce(jsonResponse(makeResponse([])));

    render(withSWR(<SentHistoryArchive />));
    await waitFor(() => {
      expect(screen.getByText("good@biz.com")).toBeTruthy();
    });
    const archiveBtn = screen.getByRole("button", {
      name: /Archive 1 senders/i,
    });
    fireEvent.click(archiveBtn);

    await waitFor(() => {
      // POST should have been made
      const postCall = fetchMock.mock.calls.find((c) => {
        const init = (c[0] as { init?: { method?: string } }).init;
        return init?.method === "POST";
      });
      expect(postCall).toBeTruthy();
    });

    const postCall = fetchMock.mock.calls.find((c) => {
      const init = (c[0] as { init?: { method?: string } }).init;
      return init?.method === "POST";
    });
    const body = JSON.parse(
      (postCall?.[0] as { init: { body: string } }).init.body,
    );
    expect(body.senderEmails).toEqual(["good@biz.com"]);
    expect(body.excludeSenderEmails).toEqual(["personal@gmail.com"]);
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
    });
  });

  it("renders an exclusion badge with the right label for each reason", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makeResponse([
          makeSender({
            senderEmail: "ceo@vip.com",
            exclusionReason: "vip",
            excluded: true,
          }),
          makeSender({
            senderEmail: "alerts@chase.com",
            senderDomain: "chase.com",
            exclusionReason: "protected_class",
            excluded: true,
          }),
        ]),
      ),
    );
    render(withSWR(<SentHistoryArchive />));
    await waitFor(() => {
      expect(
        screen.getAllByTestId(/^exclusion-badge-/).length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByTestId("exclusion-badge-vip")).toBeTruthy();
    expect(screen.getByTestId("exclusion-badge-protected_class")).toBeTruthy();
  });
});
