"use client";

/**
 * EL-374 — first-time Decisions onboarding wizard.
 *
 * Shown on the Decisions page when the SenderDecision table is empty for
 * the current account. Pulls the top inbound senders from
 * /api/sender-decisions/top-senders and lets the user assign a triage
 * action (auto_trash / always_keep / review / skip) to each one without
 * leaving the page.
 *
 * Design goals:
 *   - Zero friction: no modal, no multi-step form. Inline checklist.
 *   - Safe defaults: skip > commit. Every sender starts as `pending` and
 *     only writes when the user explicitly clicks an action.
 *   - Bulk progress: bottom bar tracks `N of 20 reviewed` so the user can
 *     stop early and still feel complete.
 */

import { useCallback, useState } from "react";
import useSWR from "swr";
import {
  ArchiveIcon,
  CheckIcon,
  EyeIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type { SenderAction } from "@/generated/prisma/enums";
import type { GetTopSendersResponse } from "@/app/api/sender-decisions/top-senders/route";
import { LoadingContent } from "@/components/LoadingContent";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toastError, toastSuccess } from "@/components/Toast";

type Status = "pending" | "saving" | "saved" | "skipped";

interface RowState {
  chosen: SenderAction | null;
  status: Status;
}

const QUICK_ACTIONS: Array<{
  value: SenderAction;
  label: string;
  icon: typeof Trash2Icon;
  tone: "default" | "destructive" | "secondary";
}> = [
  {
    value: "auto_trash",
    label: "Trash",
    icon: Trash2Icon,
    tone: "destructive",
  },
  {
    value: "always_keep",
    label: "Keep",
    icon: ShieldCheckIcon,
    tone: "default",
  },
  {
    value: "auto_archive",
    label: "Archive",
    icon: ArchiveIcon,
    tone: "secondary",
  },
  { value: "review", label: "Review later", icon: EyeIcon, tone: "secondary" },
];

export function DecisionsOnboarding({
  onDone,
}: {
  onDone: () => Promise<unknown>;
}) {
  const { data, error, isLoading } = useSWR<GetTopSendersResponse>(
    "/api/sender-decisions/top-senders?limit=20",
  );
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  const senders = data?.senders ?? [];
  const reviewedCount = Object.values(rowState).filter(
    (r) => r.status === "saved" || r.status === "skipped",
  ).length;

  const commit = useCallback(
    async (senderEmail: string, action: SenderAction) => {
      setRowState((s) => ({
        ...s,
        [senderEmail]: { status: "saving", chosen: action },
      }));
      try {
        const res = await fetch("/api/sender-decisions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ senderEmail, action }),
        });
        if (!res.ok) throw new Error(await res.text());
        setRowState((s) => ({
          ...s,
          [senderEmail]: { status: "saved", chosen: action },
        }));
      } catch (err) {
        toastError({ description: String(err) });
        setRowState((s) => ({
          ...s,
          [senderEmail]: { status: "pending", chosen: null },
        }));
      }
    },
    [],
  );

  function skip(senderEmail: string) {
    setRowState((s) => ({
      ...s,
      [senderEmail]: { status: "skipped", chosen: null },
    }));
  }

  async function finish() {
    await onDone();
    toastSuccess({
      description: `Reviewed ${reviewedCount} sender${
        reviewedCount === 1 ? "" : "s"
      }. Welcome to Decisions.`,
    });
  }

  return (
    <div className="border rounded-lg bg-card p-6 mb-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="rounded-full bg-primary/10 p-2">
          <SparklesIcon className="size-5 text-primary" />
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold">
            Welcome — let's triage your top senders
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Pick a triage policy for your most active senders. You can change
            these any time. Skip anyone you're not sure about.
          </p>
        </div>
      </div>

      <LoadingContent loading={isLoading} error={error}>
        {senders.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No inbound senders yet. Come back after your first sync.
          </div>
        ) : (
          <div className="divide-y">
            {senders.map((sender, i) => {
              const state = rowState[sender.senderEmail] ?? {
                status: "pending" as Status,
                chosen: null,
              };
              const isDone =
                state.status === "saved" || state.status === "skipped";
              return (
                <div
                  key={sender.senderEmail}
                  className={`flex items-center gap-3 py-2 ${
                    isDone ? "opacity-60" : ""
                  }`}
                >
                  <div className="w-6 text-xs tabular-nums text-muted-foreground">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs truncate">
                      {sender.senderEmail}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {sender.messageCount} message
                      {sender.messageCount === 1 ? "" : "s"} ·{" "}
                      {sender.senderDomain}
                    </div>
                  </div>
                  {state.status === "saved" && state.chosen ? (
                    <Badge variant="default" className="gap-1">
                      <CheckIcon className="size-3" />
                      {state.chosen}
                    </Badge>
                  ) : state.status === "skipped" ? (
                    <Badge variant="secondary" className="gap-1">
                      <XIcon className="size-3" />
                      skipped
                    </Badge>
                  ) : (
                    <div className="flex items-center gap-1">
                      {QUICK_ACTIONS.map((opt) => (
                        <Button
                          key={opt.value}
                          size="sm"
                          variant={
                            opt.tone === "destructive"
                              ? "destructive"
                              : opt.tone === "default"
                                ? "default"
                                : "outline"
                          }
                          disabled={state.status === "saving"}
                          onClick={() => commit(sender.senderEmail, opt.value)}
                        >
                          <opt.icon className="size-3 mr-1" />
                          {opt.label}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={state.status === "saving"}
                        onClick={() => skip(sender.senderEmail)}
                      >
                        Skip
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </LoadingContent>

      <div className="flex items-center justify-between mt-4 pt-4 border-t">
        <div className="text-sm text-muted-foreground">
          {reviewedCount} of {senders.length} reviewed
        </div>
        <Button onClick={finish} disabled={reviewedCount === 0}>
          {reviewedCount === senders.length
            ? "Finish"
            : `Done for now (${reviewedCount})`}
        </Button>
      </div>
    </div>
  );
}
