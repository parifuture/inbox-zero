"use client";

import { useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { AlertOctagonIcon, PauseIcon, PlayIcon } from "lucide-react";
import type {
  KillSwitchGetResponse,
  KillSwitchPostResponse,
} from "@/app/api/user/kill-switch/route";
import { Button } from "@/components/ui/button";
import { toastError, toastSuccess } from "@/components/Toast";

const KILL_SWITCH_URL = "/api/user/kill-switch";

/**
 * EL-370 kill-switch banner. Always mounted in the app shell. When paused,
 * renders a persistent red banner with a prominent Resume button; when
 * running, renders a compact "pause autonomous actions" button.
 *
 * Kept quiet by default so it doesn't add chrome to every page \u2014 the
 * running-state button is muted, the paused banner is loud.
 */
export function KillSwitchBanner() {
  const { data, mutate } = useSWR<KillSwitchGetResponse>(KILL_SWITCH_URL, {
    // Refresh on window focus so if the flag is flipped in another tab /
    // via the API we pick it up quickly. Kill-switch propagation target is
    // \u2264 5s (ticket acceptance).
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
  const [submitting, setSubmitting] = useState(false);

  async function toggle(paused: boolean, reason?: string | null) {
    setSubmitting(true);
    try {
      const resp = await fetch(KILL_SWITCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused, reason: reason ?? null }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        toastError({
          title: paused
            ? "Could not pause autonomous actions"
            : "Could not resume autonomous actions",
          description: body?.error ?? `HTTP ${resp.status}`,
        });
        return;
      }
      const next = (await resp.json()) as KillSwitchPostResponse;
      await mutate(next, { revalidate: false });
      await globalMutate(KILL_SWITCH_URL);
      toastSuccess({
        title: paused
          ? "Autonomous actions paused"
          : "Autonomous actions resumed",
        description: paused
          ? "The rules engine will record matches but take NO Gmail actions."
          : "Rules engine will resume taking Gmail actions.",
      });
    } catch (err) {
      toastError({
        title: "Kill-switch toggle failed",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!data) return null;

  if (data.paused) {
    const since = data.pausedAt
      ? new Date(data.pausedAt).toLocaleString()
      : null;
    return (
      <div className="sticky top-0 z-50 border-b border-destructive/70 bg-destructive text-destructive-foreground px-4 py-2 flex items-center justify-between gap-3 shadow-sm">
        <div className="flex items-center gap-2 text-sm">
          <AlertOctagonIcon className="size-4 shrink-0" />
          <span className="font-medium">AUTONOMOUS ACTIONS PAUSED</span>
          <span className="opacity-90">
            {since ? `since ${since}` : ""}
            {data.pausedBy ? ` \u00b7 by ${data.pausedBy}` : ""}
            {data.pauseReason ? ` \u00b7 ${data.pauseReason}` : ""}
          </span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => toggle(false)}
          disabled={submitting}
        >
          <PlayIcon className="size-4 mr-2" />
          {submitting ? "Resuming\u2026" : "Resume"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex justify-end px-4 pt-2">
      <Button
        size="sm"
        variant="outline"
        className="text-xs"
        onClick={() => {
          const reason =
            typeof window !== "undefined"
              ? window.prompt(
                  "Pause autonomous actions. Reason (optional):",
                  "",
                )
              : null;
          // null = user cancelled
          if (reason === null) return;
          toggle(true, reason.trim() || null);
        }}
        disabled={submitting}
      >
        <PauseIcon className="size-4 mr-1" />
        {submitting ? "Pausing\u2026" : "\u26d4 Pause autonomous actions"}
      </Button>
    </div>
  );
}
