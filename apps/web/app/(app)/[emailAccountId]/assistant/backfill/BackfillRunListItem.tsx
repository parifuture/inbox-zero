/**
 * EL-472 — One row in the recent-runs list.
 */

"use client";

import {
  CheckCircle2Icon,
  CircleAlertIcon,
  ClockIcon,
  PauseIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { BackfillRunListResponse } from "@/app/api/backfill/route";

const STATUS_ICON: Record<string, React.ReactNode> = {
  done: <CheckCircle2Icon className="size-4 text-green-600" />,
  error: <CircleAlertIcon className="size-4 text-destructive" />,
  stopped: <PauseIcon className="size-4 text-muted-foreground" />,
};

export function BackfillRunListItem({
  run,
  onSelect,
}: {
  run: BackfillRunListResponse[number];
  onSelect: () => void;
}) {
  const icon = STATUS_ICON[run.status] ?? (
    <ClockIcon className="size-4 text-muted-foreground" />
  );
  return (
    <Card>
      <CardContent className="p-3">
        <button
          type="button"
          onClick={onSelect}
          className="w-full flex items-center gap-3 text-left"
        >
          <div className="shrink-0">{icon}</div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">
              {new Date(run.createdAt).toLocaleString()}
              {run.senderScope ? (
                <>
                  {" "}
                  · <span className="font-mono text-xs">{run.senderScope}</span>
                </>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">
              {run.ruleIds.length} rule
              {run.ruleIds.length === 1 ? "" : "s"} · {run.totalDecisions}{" "}
              decisions · {run.executedDecisions} applied
              {run.errorCount > 0 ? ` · ${run.errorCount} errors` : ""}
            </div>
          </div>
          <Badge variant="outline" className="shrink-0">
            {run.status}
          </Badge>
        </button>
      </CardContent>
    </Card>
  );
}
