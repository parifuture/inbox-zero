"use client";

import { useCallback, useMemo, useState } from "react";
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

const PAGE_LIMIT = 100;

export function HistoricalCleanup() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<SenderStatusFilter>("active");
  const [sort, setSort] = useState<SenderSortKey>("count");
  const [order, setOrder] = useState<SenderSortOrder>("desc");
  const [selectedRow, setSelectedRow] = useState<Sender | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [isWorking, setIsWorking] = useState(false);

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
    </PageWrapper>
  );
}
