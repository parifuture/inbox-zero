"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  Loader2Icon,
  SearchIcon,
} from "lucide-react";
import type { GetAdminParityMetricsResponse } from "@/app/api/admin/parity/metrics/route";
import type {
  GetAdminParityMismatchesResponse,
  ParityMismatchRow,
} from "@/app/api/admin/parity/mismatches/route";
import type { GetAdminParityTimeseriesResponse } from "@/app/api/admin/parity/timeseries/route";
import type { PostAdminParityOverrideResponse } from "@/app/api/admin/parity/override/route";
import { LoadingContent } from "@/components/LoadingContent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const MISMATCH_TYPES = [
  { value: "any", label: "Any mismatch" },
  { value: "fork_trash_sidecar_keep", label: "fork=trash / sidecar=keep" },
  { value: "fork_keep_sidecar_trash", label: "fork=keep / sidecar=trash" },
  { value: "fork_review_sidecar_trash", label: "fork=review / sidecar=trash" },
  { value: "fork_trash_sidecar_review", label: "fork=trash / sidecar=review" },
  { value: "other", label: "Other" },
] as const;

type MismatchType = (typeof MISMATCH_TYPES)[number]["value"];

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
};

function formatPct(rate: number | null, digits = 2): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(digits)}%`;
}

function formatInt(n: number): string {
  return n.toLocaleString();
}

function StatCard({
  title,
  stats,
  window,
}: {
  title: string;
  stats: GetAdminParityMetricsResponse | undefined;
  window: string;
}) {
  const agg = stats?.stats;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center justify-between">
          <span>{title}</span>
          <span className="text-xs font-normal">{window}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!agg ? (
          <div className="text-2xl font-semibold">—</div>
        ) : (
          <>
            <div className="text-3xl font-semibold">
              {formatPct(agg.agreementRate, 2)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatInt(agg.agreed)} agreed / {formatInt(agg.compared)}{" "}
              compared · {formatInt(agg.total)} total
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AgreementSparkline({
  points,
}: {
  points: GetAdminParityTimeseriesResponse["points"] | undefined;
}) {
  const series = useMemo(() => {
    if (!points || points.length === 0) return null;
    return points.map((p) => p.agreementRate ?? 1);
  }, [points]);

  if (!series) {
    return (
      <div className="h-16 flex items-center justify-center text-xs text-muted-foreground">
        No data yet
      </div>
    );
  }

  const w = 320;
  const h = 64;
  const pad = 4;
  const n = series.length;
  const coords = series.map((v, i) => {
    const x = pad + (i * (w - 2 * pad)) / Math.max(1, n - 1);
    const y = h - pad - v * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = `M ${coords.join(" L ")}`;
  const last = series[series.length - 1];

  return (
    <svg
      role="img"
      aria-label="30-day agreement rate"
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-16"
    >
      <line
        x1={pad}
        x2={w - pad}
        y1={h - pad - 0.99 * (h - 2 * pad)}
        y2={h - pad - 0.99 * (h - 2 * pad)}
        stroke="currentColor"
        strokeDasharray="2 2"
        className="text-muted-foreground/30"
      />
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-primary"
      />
      <text
        x={w - pad}
        y={12}
        textAnchor="end"
        className="fill-muted-foreground text-[10px]"
      >
        now: {formatPct(last ?? null, 1)}
      </text>
    </svg>
  );
}

function ActionBadge({ action }: { action: string }) {
  const variant =
    action === "trash"
      ? "destructive"
      : action === "review"
        ? "outline"
        : action === "inbox"
          ? "default"
          : "secondary";
  return <Badge variant={variant}>{action}</Badge>;
}

function MismatchRow({
  row,
  onApplied,
}: {
  row: ParityMismatchRow;
  onApplied: () => void;
}) {
  const [busy, setBusy] = useState<"fork" | "sidecar" | null>(null);
  const [applied, setApplied] = useState<"fork" | "sidecar" | null>(null);

  const apply = async (preference: "fork" | "sidecar") => {
    setBusy(preference);
    try {
      const res = await fetch("/api/admin/parity/override", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parityDecisionId: row.id,
          preference,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as PostAdminParityOverrideResponse;
      setApplied(preference);
      toast.success(`Override saved: ${json.senderEmail} → ${json.action}`);
      onApplied();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to apply override");
    } finally {
      setBusy(null);
    }
  };

  const gmailUrl = row.threadId
    ? `https://mail.google.com/mail/u/0/#inbox/${row.threadId}`
    : null;

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {new Date(row.createdAt).toLocaleString()}
      </TableCell>
      <TableCell className="max-w-[220px] truncate" title={row.senderEmail}>
        {row.senderEmail}
      </TableCell>
      <TableCell
        className="max-w-[260px] truncate text-sm"
        title={row.subject ?? ""}
      >
        {row.subject ?? <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell>
        <ActionBadge action={row.forkAction} />
      </TableCell>
      <TableCell>
        <ActionBadge action={row.sidecarAction} />
      </TableCell>
      <TableCell
        className="max-w-[160px] truncate text-xs text-muted-foreground"
        title={row.forkRuleName ?? ""}
      >
        {row.forkRuleName ?? "—"}
      </TableCell>
      <TableCell
        className="max-w-[160px] truncate text-xs text-muted-foreground"
        title={row.sidecarRuleName ?? ""}
      >
        {row.sidecarRuleName ?? "—"}
      </TableCell>
      <TableCell>
        {gmailUrl ? (
          <a
            href={gmailUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            thread
            <ExternalLinkIcon className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={applied === "fork" ? "default" : "outline"}
            disabled={busy !== null || applied !== null}
            onClick={() => apply("fork")}
          >
            {busy === "fork" ? (
              <Loader2Icon className="h-3 w-3 animate-spin" />
            ) : applied === "fork" ? (
              <CheckCircle2Icon className="h-3 w-3" />
            ) : null}
            <span className="ml-1">Prefer fork</span>
          </Button>
          <Button
            size="sm"
            variant={applied === "sidecar" ? "default" : "outline"}
            disabled={busy !== null || applied !== null}
            onClick={() => apply("sidecar")}
          >
            {busy === "sidecar" ? (
              <Loader2Icon className="h-3 w-3 animate-spin" />
            ) : applied === "sidecar" ? (
              <CheckCircle2Icon className="h-3 w-3" />
            ) : null}
            <span className="ml-1">Prefer sidecar</span>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ParityDashboard() {
  const [mismatchType, setMismatchType] = useState<MismatchType>("any");
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: m24 } = useSWR<GetAdminParityMetricsResponse>(
    "/api/admin/parity/metrics?days=1",
    fetcher,
  );
  const { data: m7 } = useSWR<GetAdminParityMetricsResponse>(
    "/api/admin/parity/metrics?days=7",
    fetcher,
  );
  const { data: m30 } = useSWR<GetAdminParityMetricsResponse>(
    "/api/admin/parity/metrics?days=30",
    fetcher,
  );
  const { data: timeseries } = useSWR<GetAdminParityTimeseriesResponse>(
    "/api/admin/parity/timeseries?days=30",
    fetcher,
  );

  const mismatchUrl = useMemo(() => {
    const params = new URLSearchParams();
    params.set("days", "30");
    params.set("limit", "100");
    if (mismatchType !== "any") params.set("mismatchType", mismatchType);
    if (searchQuery) params.set("search", searchQuery);
    return `/api/admin/parity/mismatches?${params.toString()}`;
  }, [mismatchType, searchQuery]);

  const {
    data: mismatches,
    error: mismatchError,
    isLoading: mismatchLoading,
    mutate: refetchMismatches,
  } = useSWR<GetAdminParityMismatchesResponse>(mismatchUrl, fetcher);

  const hasAnyData = (m30?.stats.total ?? 0) > 0 || (m7?.stats.total ?? 0) > 0;

  if (m30 && !hasAnyData) {
    return (
      <Card>
        <CardContent className="py-10 flex flex-col items-center gap-3 text-center">
          <AlertTriangleIcon className="h-8 w-8 text-muted-foreground" />
          <div className="text-lg font-medium">No parity data yet</div>
          <div className="text-sm text-muted-foreground max-w-md">
            The EL-363 shadow-mode harness hasn&apos;t written any
            <code className="mx-1 rounded bg-muted px-1 py-0.5">
              ParityDecision
            </code>
            rows yet. Run the shadow runner and sidecar backfill to populate
            this dashboard:
            <pre className="mt-3 text-xs text-left bg-muted p-2 rounded">
              {`pnpm -F web tsx scripts/backfill-sidecar-decisions.ts --days 7
pnpm -F web tsx scripts/parity-report.ts --days 7`}
            </pre>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top strip: 24h / 7d / 30d agreement */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="Agreement" stats={m24} window="24h" />
        <StatCard title="Agreement" stats={m7} window="7d" />
        <StatCard title="Agreement" stats={m30} window="30d" />
      </div>

      {/* Sparkline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Agreement rate — last 30 days
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AgreementSparkline points={timeseries?.points} />
          <div className="mt-1 text-xs text-muted-foreground">
            Dashed line = 99% sidecar-sunset threshold.
          </div>
        </CardContent>
      </Card>

      {/* Action-drift summary */}
      {m30 && m30.stats.actionDrift.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Action drift — last 30 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fork</TableHead>
                  <TableHead>Sidecar</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {m30.stats.actionDrift.map((d) => (
                  <TableRow key={`${d.forkAction}::${d.sidecarAction}`}>
                    <TableCell>
                      <ActionBadge action={d.forkAction} />
                    </TableCell>
                    <TableCell>
                      <ActionBadge action={d.sidecarAction} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatInt(d.count)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Mismatches table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center justify-between">
            <span>Recent mismatches</span>
            <span className="text-xs font-normal">
              {mismatches
                ? `${mismatches.items.length} / ${mismatches.total} shown`
                : ""}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col sm:flex-row gap-2 mb-4"
            onSubmit={(e) => {
              e.preventDefault();
              setSearchQuery(search.trim());
            }}
          >
            <div className="relative flex-1">
              <SearchIcon className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sender email…"
                className="pl-8"
              />
            </div>
            <Select
              value={mismatchType}
              onValueChange={(v) => setMismatchType(v as MismatchType)}
            >
              <SelectTrigger className="w-full sm:w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MISMATCH_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" variant="outline">
              Apply
            </Button>
          </form>

          <LoadingContent
            loading={mismatchLoading}
            error={mismatchError}
            loadingComponent={
              <div className="py-10 flex justify-center">
                <Loader2Icon className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            }
          >
            {mismatches && mismatches.items.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No mismatches in the current window.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Sender</TableHead>
                      <TableHead>Subject</TableHead>
                      <TableHead>Fork</TableHead>
                      <TableHead>Sidecar</TableHead>
                      <TableHead>Fork rule</TableHead>
                      <TableHead>Sidecar rule</TableHead>
                      <TableHead>Thread</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mismatches?.items.map((row) => (
                      <MismatchRow
                        key={row.id}
                        row={row}
                        onApplied={() => refetchMismatches()}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </LoadingContent>
        </CardContent>
      </Card>
    </div>
  );
}
