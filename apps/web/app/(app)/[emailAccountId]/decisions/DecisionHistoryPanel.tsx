"use client";

import useSWR from "swr";
import { ClockIcon } from "lucide-react";
import type { SenderDecisionHistoryResponse } from "@/app/api/sender-decisions/[senderEmail]/history/route";
import { LoadingContent } from "@/components/LoadingContent";
import { Badge } from "@/components/ui/badge";

function formatAction(a: unknown): string {
  if (typeof a === "object" && a !== null && "action" in a) {
    return String((a as Record<string, unknown>).action);
  }
  return "—";
}

export function DecisionHistoryPanel({ senderEmail }: { senderEmail: string }) {
  const url = senderEmail
    ? `/api/sender-decisions/${encodeURIComponent(senderEmail)}/history?limit=50`
    : null;
  const { data, error, isLoading } = useSWR<SenderDecisionHistoryResponse>(url);

  return (
    <div className="border-t">
      <div className="px-4 py-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <ClockIcon className="size-3.5" />
        History
        {data?.items.length ? (
          <span className="text-muted-foreground/70 normal-case font-normal">
            ({data.items.length})
          </span>
        ) : null}
      </div>
      <LoadingContent loading={isLoading} error={error}>
        {data && data.items.length === 0 ? (
          <div className="px-4 pb-4 text-xs text-muted-foreground">
            No recorded changes for this sender yet.
          </div>
        ) : (
          <div className="max-h-64 overflow-auto">
            <ol className="px-4 pb-4 flex flex-col gap-2">
              {(data?.items ?? []).map((entry) => {
                const beforeAction = formatAction(entry.before);
                const afterAction = formatAction(entry.after);
                return (
                  <li
                    key={entry.id}
                    className="text-xs border rounded px-2 py-1.5 flex flex-col gap-1"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary" className="text-[10px]">
                        {entry.action}
                      </Badge>
                      <span className="font-mono">
                        {beforeAction} → {afterAction}
                      </span>
                      <span className="text-muted-foreground ml-auto">
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
                      <span>actor: {entry.actor}</span>
                      {entry.source ? (
                        <span>· source: {entry.source}</span>
                      ) : null}
                      {entry.reason ? (
                        <span className="italic">· {entry.reason}</span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </LoadingContent>
    </div>
  );
}
