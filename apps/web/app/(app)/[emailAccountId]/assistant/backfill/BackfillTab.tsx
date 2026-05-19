/**
 * EL-472 — Backfill tab.
 *
 * Top-level component for the new "Backfill" tab under Assistant.
 * Shows mirror freshness, recent runs, and either a config-new-run
 * pane or a live-progress pane depending on whether there's an
 * active run.
 *
 * Architecture recap:
 *   - Mirror SQLite is the read source (~/data/gmail-mirror/mirror.db).
 *   - LLM evaluates one sender at a time, returns dispositions.
 *   - Decisions land in Postgres BEFORE Gmail mutation.
 *   - User must hit Execute to actually apply (Phase 1 dry-run gate).
 */

"use client";

import { useState } from "react";
import useSWR from "swr";
import { HardDriveIcon, AlertTriangleIcon, HistoryIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingContent } from "@/components/LoadingContent";
import { MutedText } from "@/components/Typography";
import type { BackfillMirrorResponse } from "@/app/api/backfill/mirror/route";
import type { BackfillRunListResponse } from "@/app/api/backfill/route";
import { BackfillRunConfig } from "./BackfillRunConfig";
import { BackfillRunDetail } from "./BackfillRunDetail";
import { BackfillRunListItem } from "./BackfillRunListItem";

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return "just now";
  const m = Math.floor(dt / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function BackfillTab() {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const { data: mirror, isLoading: mirrorLoading } =
    useSWR<BackfillMirrorResponse>("/api/backfill/mirror");

  const {
    data: runs,
    isLoading: runsLoading,
    mutate: mutateRuns,
  } = useSWR<BackfillRunListResponse>("/api/backfill", {
    refreshInterval: activeRunId ? 0 : 5000,
  });

  const handleStart = async (newRunId: string) => {
    setActiveRunId(newRunId);
    await mutateRuns();
  };

  if (activeRunId) {
    return (
      <BackfillRunDetail
        runId={activeRunId}
        onClose={() => {
          setActiveRunId(null);
          mutateRuns();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-4">
          <LoadingContent loading={mirrorLoading}>
            {!mirror ? null : !mirror.available ? (
              <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangleIcon className="size-4 shrink-0" />
                Local Gmail mirror is not available — Backfill is offline. Run
                the gmail-mirror sync to enable it.
                {mirror.error ? (
                  <span className="text-xs text-muted-foreground">
                    ({mirror.error})
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <HardDriveIcon className="size-4 text-muted-foreground" />
                <span>
                  Mirror has{" "}
                  <strong>{mirror.totalRows.toLocaleString()}</strong> emails
                  synced.
                </span>
                <Badge variant="outline">
                  Last sync {formatRelative(mirror.lastSyncAt)}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {mirror.dbPath}
                </span>
              </div>
            )}
          </LoadingContent>
        </CardContent>
      </Card>

      {mirror?.available ? <BackfillRunConfig onStart={handleStart} /> : null}

      <div>
        <div className="flex items-center gap-2 mb-2">
          <HistoryIcon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Recent runs</h3>
        </div>
        <LoadingContent loading={runsLoading}>
          {!runs || runs.length === 0 ? (
            <MutedText className="text-sm">
              No backfill runs yet. Configure one above.
            </MutedText>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <BackfillRunListItem
                  key={run.id}
                  run={run}
                  onSelect={() => setActiveRunId(run.id)}
                />
              ))}
            </div>
          )}
        </LoadingContent>
      </div>
    </div>
  );
}
