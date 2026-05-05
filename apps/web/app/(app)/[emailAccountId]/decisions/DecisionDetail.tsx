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
  ApplyRetroPreviewResponse,
} from "@/app/api/sender-decisions/[senderEmail]/apply-retro/route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
  applyRetroSignal,
}: {
  decision: SenderDecision | null;
  onActionChange: (action: SenderAction) => void;
  applyRetroSignal?: number;
}) {
  const [retroOpen, setRetroOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<ApplyRetroPreviewResponse | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [overrideChecked, setOverrideChecked] = useState(false);

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
    setPreview(null);
    setPreviewError(null);
    setTypedConfirm("");
    setOverrideChecked(false);
  }, [decision?.senderEmail]);

  // Parent fires this signal when the user presses "x" on the focused row.
  // Skip the initial mount (signal === 0). We intentionally depend only on
  // the signal counter — reacting to decision/jobActive changes would spam
  // the modal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  useEffect(() => {
    if (!applyRetroSignal) return;
    if (!decision) return;
    if (
      decision.action !== "auto_trash" &&
      decision.action !== "auto_archive" &&
      decision.action !== "always_keep"
    )
      return;
    if (jobActive) return;
    openRetroModal();
  }, [applyRetroSignal]);

  async function openRetroModal() {
    if (!decision || !jobUrl) return;
    setRetroOpen(true);
    setPreview(null);
    setPreviewError(null);
    setTypedConfirm("");
    setOverrideChecked(false);
    setPreviewLoading(true);
    try {
      const resp = await fetch(jobUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preview: true }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        setPreviewError(body?.error ?? `HTTP ${resp.status}`);
        return;
      }
      const parsed = (await resp.json()) as ApplyRetroPreviewResponse;
      setPreview(parsed);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function startBacklogJob() {
    if (!decision || !jobUrl || !preview) return;
    const overHard = preview.overHardCap || preview.count > preview.hardCap;
    const overSoft = preview.count > preview.softCap;
    const body: Record<string, unknown> = {};
    if (overSoft) {
      body.confirm = true;
      body.expectedCount = preview.count;
    }
    if (overHard) {
      body.override = true;
    }
    setSubmitting(true);
    try {
      const resp = await fetch(jobUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const parsed = await resp.json().catch(() => ({}));
        toastError({
          title: "Could not start backlog apply",
          description: parsed?.error ?? `HTTP ${resp.status}`,
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
              onClick={openRetroModal}
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
                ? `Trash existing emails from ${decision.senderEmail}?`
                : decision.action === "auto_archive"
                  ? `Archive existing emails from ${decision.senderEmail}?`
                  : `Restore any previously trashed emails from ${decision.senderEmail} back to inbox?`}{" "}
              Uses Gmail trash (30-day recovery). Starred messages and sent
              items are preserved.
            </DialogDescription>
          </DialogHeader>

          {previewLoading ? (
            <div className="text-sm text-muted-foreground">
              Counting matching emails…
            </div>
          ) : previewError ? (
            <div className="text-sm text-destructive">{previewError}</div>
          ) : preview ? (
            (() => {
              const overHard =
                preview.overHardCap || preview.count > preview.hardCap;
              const overSoft = preview.count > preview.softCap;
              return (
                <div className="flex flex-col gap-3 text-sm">
                  <div>
                    This will affect{" "}
                    <span className="font-semibold">
                      {preview.overHardCap
                        ? `>${preview.hardCap}`
                        : preview.count}
                    </span>{" "}
                    emails from{" "}
                    <span className="font-mono">{decision.senderEmail}</span>.
                  </div>
                  {overSoft ? (
                    <div className="flex flex-col gap-1">
                      <div className="text-xs text-muted-foreground">
                        Over soft cap ({preview.softCap}). Type{" "}
                        <span className="font-mono font-semibold">APPLY</span>{" "}
                        to confirm.
                      </div>
                      <Input
                        value={typedConfirm}
                        onChange={(e) => setTypedConfirm(e.target.value)}
                        placeholder="APPLY"
                        autoFocus
                      />
                    </div>
                  ) : null}
                  {overHard ? (
                    <div className="flex items-center gap-2 text-xs text-destructive">
                      <Checkbox
                        id="apply-retro-override"
                        checked={overrideChecked}
                        onCheckedChange={(v) => setOverrideChecked(v === true)}
                      />
                      <label htmlFor="apply-retro-override">
                        Override hard cap ({preview.hardCap}). I understand this
                        is a large blast radius.
                      </label>
                    </div>
                  ) : null}
                </div>
              );
            })()
          ) : null}

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRetroOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={startBacklogJob}
              disabled={
                submitting ||
                previewLoading ||
                !preview ||
                (preview.count > preview.softCap && typedConfirm !== "APPLY") ||
                ((preview.overHardCap || preview.count > preview.hardCap) &&
                  !overrideChecked)
              }
            >
              {submitting ? "Starting…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
