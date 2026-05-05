"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { PageWrapper } from "@/components/PageWrapper";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { ScanBanner } from "./ScanBanner";
import { SenderList } from "./SenderList";
import { SenderDetail } from "./SenderDetail";
import { BulkActionsBar } from "./BulkActionsBar";
import {
  useArchiveSenders,
  useHistoricalSenders,
  useSkipSenders,
} from "./hooks";
import type {
  Sender,
  SenderSortKey,
  SenderSortOrder,
  SenderStatusFilter,
} from "./types";
import { useHotkeys } from "@/hooks/useHotkeys";
import {
  HotkeyHelpOverlay,
  type HotkeyHelpGroup,
} from "@/components/HotkeyHelpOverlay";

const HOTKEY_HELP: HotkeyHelpGroup[] = [
  {
    title: "Navigation",
    entries: [
      { keys: "j / k", description: "Move focus down / up in the sender list" },
      { keys: "g g", description: "Jump to first sender" },
      { keys: "G", description: "Jump to last sender" },
      { keys: "/", description: "Focus search" },
      { keys: "esc", description: "Clear focused sender" },
    ],
  },
  {
    title: "Actions on focused sender",
    entries: [
      { keys: "x", description: "Archive focused sender's emails" },
      { keys: "e", description: "Skip focused sender (mark as handled)" },
      { keys: "?", description: "Toggle this help overlay" },
    ],
  },
];

const PAGE_LIMIT = 100;

export function HistoricalCleanup() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<SenderStatusFilter>("active");
  const [sort, setSort] = useState<SenderSortKey>("count");
  const [order, setOrder] = useState<SenderSortOrder>("desc");
  const [selectedRow, setSelectedRow] = useState<Sender | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [isWorking, setIsWorking] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const params = useMemo(
    () => ({
      search,
      status,
      sort,
      order,
      minCount: 1,
      limit: PAGE_LIMIT,
      offset: 0,
    }),
    [search, status, sort, order],
  );

  const { data, error, isLoading, mutate } = useHistoricalSenders(params);
  const senders = data?.senders ?? [];
  const total = data?.total ?? 0;

  const archiveSenders = useArchiveSenders();
  const skipSenders = useSkipSenders();

  const onToggleRow = useCallback((email: string) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }, []);

  const onToggleAll = useCallback(
    (allChecked: boolean) => {
      setSelectedRows((prev) => {
        const next = new Set(prev);
        if (allChecked) {
          for (const s of senders) next.add(s.senderEmail);
        } else {
          for (const s of senders) next.delete(s.senderEmail);
        }
        return next;
      });
    },
    [senders],
  );

  const handleArchive = useCallback(
    async (senderEmails: string[]) => {
      if (senderEmails.length === 0) return;
      setIsWorking(true);
      try {
        await archiveSenders(senderEmails);
        setSelectedRows((prev) => {
          const next = new Set(prev);
          for (const e of senderEmails) next.delete(e);
          return next;
        });
        await mutate();
      } finally {
        setIsWorking(false);
      }
    },
    [archiveSenders, mutate],
  );

  const handleSkip = useCallback(
    async (senderEmails: string[]) => {
      if (senderEmails.length === 0) return;
      setIsWorking(true);
      try {
        await skipSenders(senderEmails);
        setSelectedRows((prev) => {
          const next = new Set(prev);
          for (const e of senderEmails) next.delete(e);
          return next;
        });
        await mutate();
      } finally {
        setIsWorking(false);
      }
    },
    [skipSenders, mutate],
  );

  const onScanCompleted = useCallback(() => {
    mutate();
  }, [mutate]);

  const onOrderToggle = useCallback(() => {
    setOrder((prev) => (prev === "desc" ? "asc" : "desc"));
  }, []);

  const onStatusChange = useCallback((next: SenderStatusFilter) => {
    setStatus(next);
    setSelectedRows(new Set());
    setSelectedRow(null);
  }, []);

  const selectedSenders = useMemo(
    () =>
      senders
        .filter((s) => selectedRows.has(s.senderEmail))
        .map((s) => ({ senderEmail: s.senderEmail, count: s.count })),
    [senders, selectedRows],
  );

  const focusedIndex = useMemo(
    () =>
      selectedRow
        ? senders.findIndex((s) => s.senderEmail === selectedRow.senderEmail)
        : -1,
    [selectedRow, senders],
  );

  const moveFocus = useCallback(
    (delta: number) => {
      if (senders.length === 0) return;
      const next =
        focusedIndex === -1
          ? delta > 0
            ? 0
            : senders.length - 1
          : Math.min(senders.length - 1, Math.max(0, focusedIndex + delta));
      setSelectedRow(senders[next] ?? null);
    },
    [senders, focusedIndex],
  );

  useHotkeys(
    {
      j: () => moveFocus(1),
      k: () => moveFocus(-1),
      "g g": () => senders[0] && setSelectedRow(senders[0]),
      G: () =>
        senders.length && setSelectedRow(senders[senders.length - 1] ?? null),
      "/": () => searchRef.current?.focus(),
      "?": () => setHelpOpen((v) => !v),
      esc: () => setSelectedRow(null),
      x: () => {
        if (selectedRow) handleArchive([selectedRow.senderEmail]);
      },
      e: () => {
        if (selectedRow) handleSkip([selectedRow.senderEmail]);
      },
    },
    { enabled: !helpOpen },
  );

  return (
    <PageWrapper>
      <PageHeader
        title="Historical Cleanup"
        description="Review and bulk-archive senders that emailed you before Jan 1 2024."
      />

      <div className="mt-4">
        <ScanBanner onScanCompleted={onScanCompleted} />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col md:flex-row min-h-[60vh]">
          <div className="md:w-1/2 md:border-r flex flex-col">
            <SenderList
              senders={senders}
              isLoading={isLoading}
              error={error}
              total={total}
              search={search}
              onSearchChange={setSearch}
              searchInputRef={searchRef}
              status={status}
              onStatusChange={onStatusChange}
              sort={sort}
              order={order}
              onSortChange={setSort}
              onOrderToggle={onOrderToggle}
              selectedRows={selectedRows}
              onToggleRow={onToggleRow}
              onToggleAll={onToggleAll}
              selectedRowEmail={selectedRow?.senderEmail ?? null}
              onSelectRow={setSelectedRow}
              onArchive={handleArchive}
              onSkip={handleSkip}
              emptyMessage={
                total === 0 && status === "active" && !search
                  ? "Run a scan to discover senders from before Jan 1 2024."
                  : undefined
              }
            />
          </div>
          <div className="md:w-1/2 flex flex-col">
            <SenderDetail
              sender={selectedRow}
              onArchive={handleArchive}
              isArchiving={isWorking}
            />
          </div>
        </div>
      </Card>

      <BulkActionsBar
        selectedSenders={selectedSenders}
        onArchive={() => handleArchive(Array.from(selectedRows))}
        onSkip={() => handleSkip(Array.from(selectedRows))}
        onClear={() => setSelectedRows(new Set())}
        isWorking={isWorking}
      />

      <HotkeyHelpOverlay
        open={helpOpen}
        onOpenChange={setHelpOpen}
        groups={HOTKEY_HELP}
      />
    </PageWrapper>
  );
}
