"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingContent } from "@/components/LoadingContent";
import { fetchWithAccount } from "@/utils/fetch";
import { useAccount } from "@/providers/EmailAccountProvider";
import type {
  SendersListResponse,
  SenderRow,
  SenderRowAction,
  SenderActionResponse,
} from "@/app/api/senders/route";

const ENDPOINT = "/api/senders";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed with ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All senders" },
  { value: "archive_forever", label: "📥 Archive forever" },
  { value: "delete", label: "🗑️ Delete (trash)" },
  { value: "custom_rule", label: "🤖 Custom rule" },
  { value: "none", label: "No action" },
  { value: "vip", label: "VIPs" },
  { value: "blocked", label: "Blocked" },
];

const ACTION_LABELS: Record<SenderRowAction, string> = {
  none: "—",
  archive_forever: "📥 Archive",
  delete: "🗑️ Delete",
  custom_rule: "🤖 Rule",
};

export function SendersPage() {
  const { emailAccountId } = useAccount();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [pendingByEmail, setPendingByEmail] = useState<Record<string, boolean>>(
    {},
  );
  const [optimisticByEmail, setOptimisticByEmail] = useState<
    Record<string, SenderRowAction>
  >({});
  const [chatSender, setChatSender] = useState<SenderRow | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (filter !== "all") params.set("filter", filter);
    params.set("limit", "300");
    return params.toString();
  }, [search, filter]);

  const { data, error, isLoading, mutate } = useSWR<SendersListResponse>(
    emailAccountId ? [ENDPOINT, emailAccountId, queryString] : null,
    async ([url, , qs]) => {
      const fullUrl = qs ? `${url}?${qs}` : (url as string);
      const res = await fetchWithAccount({
        url: fullUrl,
        emailAccountId,
      });
      return jsonOrThrow<SendersListResponse>(res);
    },
    { keepPreviousData: true },
  );

  const senders = data?.senders ?? [];
  const killSwitchPaused = data?.killSwitchPaused ?? false;

  const onApplyAction = useCallback(
    async (sender: SenderRow, action: SenderRowAction) => {
      if (!emailAccountId) return;

      // Confirmation gates for destructive actions:
      if (action === "delete") {
        const ok = window.confirm(
          `Delete (trash) all emails from ${sender.senderEmail}?\n\n` +
            `• ${sender.receivedCount} existing emails will move to Trash (30-day recovery)\n` +
            "• Future emails from this sender will be auto-trashed\n" +
            "• Use Bulk Undo to restore within 24h if you change your mind\n\n" +
            "This is NOT permanent delete — emails stay in Trash for 30 days before Gmail purges them.",
        );
        if (!ok) return;
      }

      setPendingByEmail((p) => ({ ...p, [sender.senderEmail]: true }));
      setOptimisticByEmail((p) => ({ ...p, [sender.senderEmail]: action }));

      try {
        const res = await fetchWithAccount({
          url: ENDPOINT,
          emailAccountId,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              senderEmail: sender.senderEmail,
              action,
              retroactive: action === "archive_forever" || action === "delete",
            }),
          },
        });
        const body = await jsonOrThrow<SenderActionResponse>(res);

        if (body.killSwitchPaused) {
          toast.warning(
            "Autonomous actions are paused (kill switch). State saved but no Gmail changes were made.",
          );
        } else if (action === "archive_forever") {
          toast.success(
            `Archived ${body.retroactiveApplied} emails from ${sender.senderEmail}. Future mail will be auto-archived.`,
          );
        } else if (action === "delete") {
          toast.success(
            `Trashed ${body.retroactiveApplied} emails from ${sender.senderEmail}. Future mail will be auto-trashed (30-day recovery).`,
          );
        } else if (action === "custom_rule") {
          toast.success(
            `Custom rule placeholder set for ${sender.senderEmail}.`,
          );
        } else {
          toast.success(`Cleared action for ${sender.senderEmail}.`);
        }
        await mutate();
      } catch (e) {
        toast.error(
          `Failed to apply action: ${e instanceof Error ? e.message : "unknown error"}`,
        );
        // Revert optimistic state on error
        setOptimisticByEmail((p) => {
          const next = { ...p };
          delete next[sender.senderEmail];
          return next;
        });
      } finally {
        setPendingByEmail((p) => {
          const next = { ...p };
          delete next[sender.senderEmail];
          return next;
        });
      }
    },
    [emailAccountId, mutate],
  );

  const effectiveAction = useCallback(
    (s: SenderRow): SenderRowAction =>
      optimisticByEmail[s.senderEmail] ?? s.currentAction,
    [optimisticByEmail],
  );

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Senders</h1>
        <p className="text-sm text-muted-foreground mt-1">
          One row per sender. Pick an action per sender:{" "}
          <strong>Archive forever</strong> (keep emails, just out of inbox),{" "}
          <strong>Delete</strong> (trash, 30-day recovery),{" "}
          <strong>Custom Rule</strong> (AI chat — coming soon).
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Archive ≠ Delete ≠ Permanent Delete. Nothing here is permanent — Phase
          1 only uses Trash (recoverable for 30 days).
        </p>
      </div>

      {killSwitchPaused && (
        <Card className="p-4 mb-4 border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20">
          <p className="text-sm">
            <strong>⚠ Kill switch is paused.</strong> Per-sender state will save
            but no Gmail changes will be applied. Resume in Settings → Safety to
            re-enable autonomous actions.
          </p>
        </Card>
      )}

      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <Input
          type="search"
          placeholder="Search sender, name, or domain…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground ml-auto">
          {senders.length} sender{senders.length === 1 ? "" : "s"}
        </span>
      </div>

      <LoadingContent loading={isLoading} error={error}>
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Sender</th>
                <th className="px-4 py-3 font-medium text-right">Received</th>
                <th className="px-4 py-3 font-medium text-right">Sent</th>
                <th className="px-4 py-3 font-medium">Last received</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {senders.length === 0 && !isLoading && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    No senders match your filter.
                  </td>
                </tr>
              )}
              {senders.map((s) => {
                const action = effectiveAction(s);
                const pending = !!pendingByEmail[s.senderEmail];
                return (
                  <tr key={s.senderEmail} className="border-t">
                    <td className="px-4 py-2 align-top">
                      <div className="font-medium break-all">
                        {s.senderEmail}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {s.senderDomain}
                        {s.category && (
                          <span className="ml-2">
                            <Badge variant="outline">{s.category}</Badge>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {s.receivedCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {s.sentToThemCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">
                      {s.lastReceived ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <Badge
                        variant={action === "none" ? "outline" : "default"}
                      >
                        {ACTION_LABELS[action]}
                      </Badge>
                      {s.isVip && (
                        <Badge variant="secondary" className="ml-1">
                          VIP
                        </Badge>
                      )}
                      {s.isBlocked && (
                        <Badge variant="destructive" className="ml-1">
                          Blocked
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1 justify-end flex-wrap">
                        <Button
                          size="sm"
                          variant={
                            action === "archive_forever" ? "default" : "outline"
                          }
                          disabled={pending}
                          onClick={() => onApplyAction(s, "archive_forever")}
                          title="Archive forever — keep emails (out of inbox), retroactive + future"
                        >
                          📥 Archive
                        </Button>
                        <Button
                          size="sm"
                          variant={
                            action === "delete" ? "destructive" : "outline"
                          }
                          disabled={pending}
                          onClick={() => onApplyAction(s, "delete")}
                          title="Delete (trash, 30-day recovery) — retroactive + future"
                        >
                          🗑️ Delete
                        </Button>
                        <Button
                          size="sm"
                          variant={
                            action === "custom_rule" ? "default" : "outline"
                          }
                          disabled={pending}
                          onClick={() => setChatSender(s)}
                          title="Build a custom rule via AI chat (coming soon)"
                        >
                          🤖 Rule
                        </Button>
                        {action !== "none" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => onApplyAction(s, "none")}
                            title="Clear action"
                          >
                            ✕
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </LoadingContent>

      {chatSender && (
        <CustomRulePlaceholderModal
          sender={chatSender}
          onClose={() => setChatSender(null)}
          onConfirmStub={async () => {
            await onApplyAction(chatSender, "custom_rule");
            setChatSender(null);
          }}
        />
      )}
    </div>
  );
}

function CustomRulePlaceholderModal({
  sender,
  onClose,
  onConfirmStub,
}: {
  sender: SenderRow;
  onClose: () => void;
  onConfirmStub: () => Promise<void>;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <Card
        className="max-w-lg w-full p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2 className="text-lg font-semibold">
          🤖 Custom Rule for {sender.senderEmail}
        </h2>
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            <strong>This feature is under construction.</strong> The full
            AI-chat rule builder lets you describe conditional logic in plain
            English (e.g. "if it's an ad, delete; if it's a form request,
            archive") and approve a generated rule before it goes live.
          </p>
          <p>
            For now, marking this sender as <em>custom_rule</em> just flags them
            in the truth table so the pipeline pauses on their mail. You can
            revisit this when the chat builder ships.
          </p>
          <p className="text-xs">
            Tracked in Linear — see{" "}
            <code>memory/projects/inbox-zero-four-actions-spec.md</code>.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onConfirmStub}>Mark as custom_rule</Button>
        </div>
      </Card>
    </div>
  );
}
