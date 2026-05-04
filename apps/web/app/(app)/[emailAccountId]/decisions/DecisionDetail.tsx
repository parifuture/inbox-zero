"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { ArchiveIcon, MailIcon } from "lucide-react";
import type { SenderAction } from "@/generated/prisma/enums";
import type { SenderDecision } from "@/generated/prisma/client";
import type { SenderMessagesResponse } from "@/app/api/sender-decisions/[senderEmail]/messages/route";
import type {
  ApplyRetroResponse,
  ApplyRetroStatusResponse,
} from "@/app/api/sender-decisions/[senderEmail]/apply-retro/route";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingContent } from "@/components/LoadingContent";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastError, toastSuccess } from "@/components/Toast";

const ACTION_LABELS: Record<SenderAction, string> = {
  auto_trash: "Auto-trash",
  auto_archive: "Auto-archive",
  always_keep: "Always keep",
  review: "Review",
};

export function DecisionDetail({
  decision,
  onActionChange,
}: {
  decision: SenderDecision | null;
  onActionChange: (action: SenderAction) => void;
}) {
  const [retroOpen, setRetroOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { data, error, isLoading } = useSWR<SenderMessagesResponse>(
    decision
      ? `/api/sender-decisions/${encodeURIComponent(decision.senderEmail)}/messages?limit=50`
      : null,
  );

  const jobUrl = decision
    ? `/api/sender-decisions/${encodeURIComponent(decision.senderEmail)}/apply-retro`
    : null;

  // Poll the latest backlog job for this sender every 2s while one is
  // pending/running so the UI can show live progress.
  const { data: jobData, mutate: refreshJob } =
    useSWR<ApplyRetroStatusResponse>(jobUrl, {
      refreshInterval: (latest) => {
        const status = latest?.job?.status;
        return status === "pending" || status === "running" ? 2000 : 0;
      },
    });
  const job = jobData?.job ?? null;
  const jobActive = job?.status === "pending" || job?.status === "running";

  useEffect(() => {
    setRetroOpen(false);
  }, [decision?.senderEmail]);

  async function startBacklogJob() {
    if (!decision || !jobUrl) return;
    setSubmitting(true);
    try {
      const resp = await fetch(jobUrl, { method: "POST" });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        toastError({
          title: "Could not start backlog apply",
          description: body?.error ?? `HTTP ${resp.status}`,
        });
        return;
      }
      const parsed = (await resp.json()) as ApplyRetroResponse;
      toastSuccess({
        title: "Applying retroactively…",
        description:
          parsed.job.status === "running" || parsed.job.status === "pending"
            ? "Job started. Progress will update live."
            : `Job ${parsed.job.status}.`,
      });
      setRetroOpen(false);
      await refreshJob();
    } catch (err) {
      toastError({
        title: "Could not start backlog apply",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!decision) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <MailIcon className="size-10 text-muted-foreground mb-3" />
        <div className="text-sm text-muted-foreground">
          Select a sender to view their messages and change the decision.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b p-4">
        <div className="font-semibold text-base font-mono">
          {decision.senderEmail}
        </div>
        <div className="flex items-center gap-2 mt-2 text-xs">
          <Badge variant="outline">{decision.senderDomain}</Badge>
          <Badge variant="secondary">{decision.messageCount} emails</Badge>
          <Badge variant="outline">source: {decision.source}</Badge>
          {decision.autoAppliedAt ? (
            <Badge variant="outline">
              applied {new Date(decision.autoAppliedAt).toLocaleDateString()}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <Select
            value={decision.action}
            onValueChange={(v) => onActionChange(v as SenderAction)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ACTION_LABELS) as SenderAction[]).map((a) => (
                <SelectItem key={a} value={a}>
                  {ACTION_LABELS[a]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {decision.action === "auto_trash" ||
          decision.action === "auto_archive" ||
          decision.action === "always_keep" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRetroOpen(true)}
              disabled={jobActive}
            >
              {jobActive
                ? `Applying… ${job?.progress ?? 0}/${job?.total ?? 0}`
                : "Apply retroactively…"}
            </Button>
          ) : null}
        </div>
        {job && !jobActive ? (
          <div className="mt-2 text-xs text-muted-foreground">
            Last run: {job.status} — {job.progress}/{job.total} messages
            {job.status === "failed" && job.error ? ` (${job.error})` : ""}
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-auto">
        <LoadingContent loading={isLoading} error={error}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="w-16 text-right">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.items ?? []).map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="text-xs whitespace-nowrap">
                    {new Date(m.date).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="truncate max-w-[320px]">
                      {/* EmailMessage has no subject column in this fork yet */}
                      {m.messageId}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {m.inbox ? (
                      <MailIcon className="size-3 inline" />
                    ) : (
                      <ArchiveIcon className="size-3 inline" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {data && data.items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center text-sm text-muted-foreground py-8"
                  >
                    No local messages from this sender yet.
                    {data.source === "local"
                      ? " (gmail-mirror fallback pending.)"
                      : null}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </LoadingContent>
      </div>

      <Dialog open={retroOpen} onOpenChange={setRetroOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply retroactively?</DialogTitle>
            <DialogDescription>
              {decision.action === "auto_trash"
                ? `Trash ~${decision.messageCount} existing emails from ${decision.senderEmail}?`
                : decision.action === "auto_archive"
                  ? `Archive ~${decision.messageCount} existing emails from ${decision.senderEmail}?`
                  : `Restore any previously trashed emails from ${decision.senderEmail} back to inbox?`}{" "}
              Uses Gmail trash (30-day recovery). Starred messages and sent
              items are preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRetroOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={startBacklogJob} disabled={submitting}>
              {submitting ? "Starting…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
