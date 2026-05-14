"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingContent } from "@/components/LoadingContent";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fetchWithAccount } from "@/utils/fetch";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  EXCLUSION_LABELS,
  type ExclusionReason,
} from "@/utils/sent-history/exclusion-rules";
import type {
  SentHistoryResponse,
  SentHistorySender,
  SentHistoryArchiveResponse,
} from "@/app/api/historical-senders/sent-history/route";

const ENDPOINT = "/api/historical-senders/sent-history";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed with ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

type RowState = "archive" | "keep";

export function SentHistoryArchive() {
  const { emailAccountId } = useAccount();
  const [search, setSearch] = useState("");
  const [overrides, setOverrides] = useState<Record<string, RowState>>({});
  const [submitting, setSubmitting] = useState(false);

  const { data, error, isLoading, mutate } = useSWR<SentHistoryResponse>(
    emailAccountId ? [ENDPOINT, emailAccountId] : null,
    async ([url]) => {
      const res = await fetchWithAccount({
        url: url as string,
        emailAccountId,
      });
      return jsonOrThrow<SentHistoryResponse>(res);
    },
    { keepPreviousData: true },
  );

  const senders = data?.senders ?? [];
  const killSwitchPaused = data?.killSwitchPaused ?? false;

  const effectiveState = useCallback(
    (s: SentHistorySender): RowState => {
      const override = overrides[s.senderEmail];
      if (override) return override;
      return s.excluded ? "keep" : "archive";
    },
    [overrides],
  );

  const moveTo = useCallback((senderEmail: string, state: RowState) => {
    setOverrides((prev) => ({ ...prev, [senderEmail]: state }));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return senders;
    return senders.filter(
      (s) =>
        s.senderEmail.includes(q) ||
        s.senderName?.toLowerCase().includes(q) ||
        s.senderDomain.includes(q),
    );
  }, [senders, search]);

  const willArchive = useMemo(
    () => filtered.filter((s) => effectiveState(s) === "archive"),
    [filtered, effectiveState],
  );
  const willKeep = useMemo(
    () => filtered.filter((s) => effectiveState(s) === "keep"),
    [filtered, effectiveState],
  );

  const archiveTotalMessages = useMemo(
    () => willArchive.reduce((acc, s) => acc + s.receivedCount, 0),
    [willArchive],
  );

  const onArchive = useCallback(async () => {
    if (!emailAccountId) return;
    if (willArchive.length === 0) return;
    setSubmitting(true);
    try {
      const archiveEmails = willArchive.map((s) => s.senderEmail);
      const excludeEmails = senders
        .filter((s) => effectiveState(s) === "keep")
        .map((s) => s.senderEmail);

      const res = await fetchWithAccount({
        url: `${ENDPOINT}`,
        emailAccountId,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            senderEmails: archiveEmails,
            excludeSenderEmails: excludeEmails,
          }),
        },
      });
      const body = await jsonOrThrow<SentHistoryArchiveResponse>(res);

      if (body.killSwitchPaused) {
        toast.error(
          "Autonomous actions are paused — unpause to run bulk archive.",
        );
        return;
      }

      const archivedCount = body.archived.reduce((acc, a) => acc + a.count, 0);
      toast.success(
        `Archived ${body.archived.length} senders (~${archivedCount} messages). Saved ${body.excluded} keep decisions.`,
      );
      setOverrides({});
      await mutate();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Archive failed";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }, [emailAccountId, willArchive, senders, effectiveState, mutate]);

  return (
    <LoadingContent loading={isLoading} error={error}>
      <div className="flex flex-col gap-4">
        {killSwitchPaused ? (
          <Card className="border-red-500 bg-red-50 p-3 text-sm text-red-900">
            <strong>Autonomous actions are paused.</strong> Unpause from the
            settings menu to run bulk archive on senders you've previously
            emailed.
          </Card>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search senders, domains, or names…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
            aria-label="Search senders"
          />
          <div className="text-sm text-muted-foreground" role="status">
            <strong>{willArchive.length}</strong> will archive
            {archiveTotalMessages > 0 ? (
              <span> (~{archiveTotalMessages} messages)</span>
            ) : null}
            <span className="px-2">·</span>
            <strong>{willKeep.length}</strong> will keep
          </div>
          <div className="ml-auto">
            <Button
              variant="default"
              disabled={
                submitting || killSwitchPaused || willArchive.length === 0
              }
              onClick={onArchive}
            >
              {submitting
                ? "Archiving…"
                : `Archive ${willArchive.length} senders`}
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <SectionCard
            title={`Will archive (${willArchive.length})`}
            tone="archive"
          >
            <SenderList
              rows={willArchive}
              moveLabel="Move to keep"
              onMove={(email) => moveTo(email, "keep")}
              showBadges={false}
            />
          </SectionCard>

          <SectionCard title={`Will keep (${willKeep.length})`} tone="keep">
            <SenderList
              rows={willKeep}
              moveLabel="Move to archive"
              onMove={(email) => moveTo(email, "archive")}
              showBadges
            />
          </SectionCard>
        </div>
      </div>
    </LoadingContent>
  );
}

function SectionCard({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "archive" | "keep";
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <div
        className={`border-b px-4 py-2 text-sm font-semibold ${
          tone === "archive"
            ? "bg-blue-50 text-blue-900"
            : "bg-amber-50 text-amber-900"
        }`}
      >
        {title}
      </div>
      <div className="max-h-96 overflow-auto">{children}</div>
    </Card>
  );
}

function SenderList({
  rows,
  moveLabel,
  onMove,
  showBadges,
}: {
  rows: SentHistorySender[];
  moveLabel: string;
  onMove: (senderEmail: string) => void;
  showBadges: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No senders in this section.
      </p>
    );
  }
  return (
    <ul className="divide-y">
      {rows.map((row) => (
        <li
          key={row.senderEmail}
          className="flex items-start gap-3 px-3 py-2 text-sm"
          data-testid="sent-history-row"
          data-sender-email={row.senderEmail}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">
              {row.senderName ? (
                <>
                  {row.senderName}{" "}
                  <span className="font-normal text-muted-foreground">
                    &lt;{row.senderEmail}&gt;
                  </span>
                </>
              ) : (
                row.senderEmail
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {row.receivedCount} received · sent {row.sentToThemCount}
              {row.lastReceivedFrom ? (
                <span> · last in {formatDate(row.lastReceivedFrom)}</span>
              ) : null}
              {row.category ? <span> · {row.category}</span> : null}
            </div>
          </div>
          {showBadges && row.exclusionReason ? (
            <ExclusionBadge reason={row.exclusionReason} />
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onMove(row.senderEmail)}
            aria-label={`${moveLabel} for ${row.senderEmail}`}
          >
            {moveLabel}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ExclusionBadge({ reason }: { reason: ExclusionReason }) {
  const meta = EXCLUSION_LABELS[reason];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className="cursor-help"
            data-testid={`exclusion-badge-${reason}`}
          >
            {meta.badge}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{meta.tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}
