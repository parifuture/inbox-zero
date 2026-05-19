/**
 * EL-472 — Run configuration.
 *
 * Picks the rules to apply, optional date floor, optional sender
 * filter. Hits POST /api/backfill which creates the run + kicks off
 * evaluation in the background.
 */

"use client";

import { useState } from "react";
import useSWR from "swr";
import { PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError } from "@/components/Toast";
import type { RulesResponse } from "@/app/api/user/rules/route";

export function BackfillRunConfig({
  onStart,
}: {
  onStart: (newRunId: string) => void;
}) {
  const { data: rules, isLoading } = useSWR<RulesResponse>("/api/user/rules");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [dateFloor, setDateFloor] = useState<string>(""); // yyyy-mm-dd
  const [senderScope, setSenderScope] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const enabledRules = rules?.filter((r) => r.enabled) ?? [];
  const selectedIds = Object.entries(selected)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const canSubmit = selectedIds.length > 0 && !submitting;

  const toggleAll = (val: boolean) => {
    const next: Record<string, boolean> = {};
    for (const r of enabledRules) next[r.id] = val;
    setSelected(next);
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/backfill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ruleIds: selectedIds,
          dateFloor: dateFloor
            ? new Date(`${dateFloor}T00:00:00`).toISOString()
            : null,
          senderScope: senderScope || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const created = (await res.json()) as { id: string };
      onStart(created.id);
    } catch (err) {
      toastError({
        title: "Couldn't start backfill",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Configure a new run</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertDescription className="text-xs">
            Phase 1 is dry-run only. Decisions will be evaluated and shown in
            the audit table — nothing is applied to Gmail until you click{" "}
            <strong>Execute</strong>.
          </AlertDescription>
        </Alert>

        <LoadingContent loading={isLoading}>
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm">Rules to apply</Label>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleAll(true)}
                  type="button"
                >
                  Select all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleAll(false)}
                  type="button"
                >
                  Select none
                </Button>
              </div>
            </div>
            <div className="border rounded-md max-h-64 overflow-auto divide-y">
              {enabledRules.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">
                  No enabled rules. Create a rule in the Rules tab first.
                </div>
              ) : (
                enabledRules.map((rule) => (
                  // biome-ignore lint/a11y/noLabelWithoutControl: label wraps Checkbox + content as a click target
                  <label
                    key={rule.id}
                    className="flex items-start gap-3 p-3 cursor-pointer hover:bg-muted/30"
                  >
                    <Checkbox
                      checked={!!selected[rule.id]}
                      onCheckedChange={(v) =>
                        setSelected((prev) => ({
                          ...prev,
                          [rule.id]: !!v,
                        }))
                      }
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {rule.name}
                      </div>
                      <div className="text-xs text-muted-foreground line-clamp-2">
                        {rule.actions
                          .map((a) =>
                            a.label ? `${a.type}:${a.label}` : a.type,
                          )
                          .join(" · ")}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
          </div>
        </LoadingContent>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="backfill-date-floor" className="text-sm mb-1 block">
              Stop at this date (optional)
            </Label>
            <Input
              id="backfill-date-floor"
              type="date"
              value={dateFloor}
              onChange={(e) => setDateFloor(e.target.value)}
            />
            <div className="text-xs text-muted-foreground mt-1">
              Leave blank to go back to your first email.
            </div>
          </div>
          <div>
            <Label
              htmlFor="backfill-sender-scope"
              className="text-sm mb-1 block"
            >
              Restrict to one sender (optional)
            </Label>
            <Input
              id="backfill-sender-scope"
              type="email"
              placeholder="newsletter@example.com"
              value={senderScope}
              onChange={(e) => setSenderScope(e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={submit} disabled={!canSubmit}>
            <PlayIcon className="size-4 mr-2" />
            {submitting
              ? "Starting…"
              : `Start backfill (${selectedIds.length} rule${selectedIds.length === 1 ? "" : "s"})`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
