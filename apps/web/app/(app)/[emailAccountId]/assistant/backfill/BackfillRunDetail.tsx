/**
 * EL-472 — Live run detail (progress + decisions audit + execute gate).
 */

"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  ArrowLeftIcon,
  PauseIcon,
  PlayIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess } from "@/components/Toast";
import { useAccount } from "@/providers/EmailAccountProvider";
import { fetchWithAccount } from "@/utils/fetch";
import type { BackfillRunDetailResponse } from "@/app/api/backfill/[runId]/route";

const TERMINAL = new Set(["done", "error", "stopped"]);

function statusBadge(status: string) {
  if (status === "done") {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircle2Icon className="size-3" /> Done
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <CircleAlertIcon className="size-3" /> Error
      </Badge>
    );
  }
  if (status === "stopped") {
    return <Badge variant="outline">Stopped</Badge>;
  }
  if (status === "awaiting_execution") {
    return <Badge variant="default">Awaiting your approval</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

export function BackfillRunDetail({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const { emailAccountId } = useAccount();
  const { data, isLoading, mutate } = useSWR<BackfillRunDetailResponse>(
    `/api/backfill/${runId}`,
    {
      // Poll while the run is active. Once terminal, stop polling.
      refreshInterval: (latest) =>
        latest &&
        (latest as NonNullable<BackfillRunDetailResponse>).run &&
        TERMINAL.has(
          (latest as NonNullable<BackfillRunDetailResponse>).run.status,
        )
          ? 0
          : 2000,
    },
  );
  const [acting, setActing] = useState<"execute" | "stop" | null>(null);

  // EL-506 — map rule UUIDs to human-readable names so the per-rule
  // activity table and recent decisions don't render bare UUIDs.
  const ruleNameById = new Map<string, string>(
    (data?.rules ?? []).map((r) => [r.id, r.name]),
  );
  const renderRuleCell = (ruleId: string | null) => {
    if (!ruleId) {
      return <em className="text-muted-foreground">(no rule)</em>;
    }
    const name = ruleNameById.get(ruleId);
    if (!name) {
      return (
        <em
          className="text-muted-foreground"
          title={`Rule ${ruleId} (deleted or unavailable)`}
        >
          (deleted rule {ruleId.slice(0, 8)})
        </em>
      );
    }
    return <span title={ruleId}>{name}</span>;
  };

  const callAction = async (kind: "execute" | "stop", successMsg: string) => {
    setActing(kind);
    try {
      // EL-507 — use fetchWithAccount so the X-Email-Account-ID header is
      // sent. The server-side auth middleware returns 403 "Email account ID
      // is required" without it.
      const res = await fetchWithAccount({
        url: `/api/backfill/${runId}/${kind === "execute" ? "execute" : "stop"}`,
        emailAccountId,
        init: { method: "POST" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toastSuccess({ description: successMsg });
      await mutate();
    } catch (err) {
      toastError({
        title: `Couldn't ${kind} run`,
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeftIcon className="size-4 mr-2" />
          Back to runs
        </Button>
      </div>

      <LoadingContent loading={isLoading}>
        {!data ? null : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle className="text-base">
                    Run started {formatTime(data.run.createdAt)}
                  </CardTitle>
                  {statusBadge(data.run.status)}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>
                      {data.run.processedSenders} of {data.run.totalSenders}{" "}
                      senders
                    </span>
                    <span>
                      {data.run.totalDecisions} decisions ·{" "}
                      {data.run.executedDecisions} executed ·{" "}
                      {data.run.errorCount} errors
                    </span>
                  </div>
                  <Progress
                    value={
                      data.run.totalSenders === 0
                        ? 0
                        : Math.min(
                            100,
                            Math.round(
                              (data.run.processedSenders /
                                Math.max(data.run.totalSenders, 1)) *
                                100,
                            ),
                          )
                    }
                  />
                  {data.run.currentSender ? (
                    <div className="text-xs text-muted-foreground mt-1">
                      Currently evaluating:{" "}
                      <span className="font-mono">
                        {data.run.currentSender}
                      </span>
                    </div>
                  ) : null}
                  {data.run.lastError ? (
                    <div className="text-xs text-destructive mt-1">
                      Last error: {data.run.lastError}
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  {data.run.status === "awaiting_execution" ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        callAction(
                          "execute",
                          "Execution started — Gmail writes are happening now.",
                        )
                      }
                      disabled={acting !== null}
                    >
                      <PlayIcon className="size-4 mr-2" />
                      {acting === "execute"
                        ? "Starting…"
                        : `Execute ${
                            data.run.totalDecisions - data.run.executedDecisions
                          } pending decisions`}
                    </Button>
                  ) : null}
                  {!TERMINAL.has(data.run.status) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => callAction("stop", "Stop signal sent.")}
                      disabled={acting !== null}
                    >
                      <PauseIcon className="size-4 mr-2" />
                      Stop
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Per-rule activity</CardTitle>
              </CardHeader>
              <CardContent>
                {data.counters.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No decisions yet.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Rule</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead className="w-24 text-right">Count</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.counters.map((c, i) => (
                        <TableRow
                          key={`${c.ruleId ?? "skip"}-${c.action}-${i}`}
                        >
                          <TableCell className="text-xs">
                            {renderRuleCell(c.ruleId)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                c.action === "TRASH"
                                  ? "destructive"
                                  : c.action === "SKIP"
                                    ? "outline"
                                    : "secondary"
                              }
                            >
                              {c.action}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {c.count.toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Recent decisions (latest 20)
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.recentDecisions.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    Nothing yet.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-32">When</TableHead>
                        <TableHead>Sender</TableHead>
                        <TableHead className="w-20">Action</TableHead>
                        <TableHead className="w-32">Rule</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead className="w-24">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.recentDecisions.map((d) => (
                        <TableRow key={d.id}>
                          <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                            {formatTime(d.decidedAt)}
                          </TableCell>
                          <TableCell className="text-xs font-mono truncate max-w-[200px]">
                            {d.sender}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                d.action === "TRASH"
                                  ? "destructive"
                                  : d.action === "SKIP"
                                    ? "outline"
                                    : "secondary"
                              }
                            >
                              {d.action}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs truncate max-w-[140px]">
                            {renderRuleCell(d.ruleId)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground line-clamp-2 max-w-[320px]">
                            {d.reason}
                          </TableCell>
                          <TableCell>
                            {d.executionError ? (
                              <Badge variant="destructive" className="text-xs">
                                Error
                              </Badge>
                            ) : d.executedAt ? (
                              <Badge variant="secondary" className="text-xs">
                                Applied
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs">
                                Pending
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </LoadingContent>
    </div>
  );
}

function formatTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}
