"use client";

import { useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type { LucideIcon } from "lucide-react";
import {
  InboxIcon,
  SearchIcon,
  Trash2Icon,
  ArchiveIcon,
  ShieldCheckIcon,
  EyeIcon,
  Loader2Icon,
} from "lucide-react";
import type { SenderAction } from "@/generated/prisma/enums";
import type { SenderDecision } from "@/generated/prisma/client";
import type { ListSenderDecisionsResponse } from "@/app/api/sender-decisions/route";
import { PageWrapper } from "@/components/PageWrapper";
import { LoadingContent } from "@/components/LoadingContent";
import { PageHeading } from "@/components/Typography";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DecisionDetail } from "@/app/(app)/[emailAccountId]/decisions/DecisionDetail";
import { DecisionsCsvToolbar } from "@/app/(app)/[emailAccountId]/decisions/DecisionsCsvToolbar";
import { DecisionsOnboarding } from "@/app/(app)/[emailAccountId]/decisions/DecisionsOnboarding";
import { toastError, toastSuccess } from "@/components/Toast";
import { useHotkeys } from "@/hooks/useHotkeys";
import {
  HotkeyHelpOverlay,
  type HotkeyHelpGroup,
} from "@/components/HotkeyHelpOverlay";

const ACTION_OPTIONS: {
  value: SenderAction;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "auto_trash", label: "Auto-trash", icon: Trash2Icon },
  { value: "auto_archive", label: "Auto-archive", icon: ArchiveIcon },
  { value: "always_keep", label: "Always keep", icon: ShieldCheckIcon },
  { value: "review", label: "Review", icon: EyeIcon },
];

function _actionBadge(action: SenderAction) {
  const opt = ACTION_OPTIONS.find((o) => o.value === action);
  if (!opt) return null;
  const variant =
    action === "auto_trash"
      ? "destructive"
      : action === "always_keep"
        ? "default"
        : "secondary";
  return <Badge variant={variant}>{opt.label}</Badge>;
}

const HOTKEY_HELP: HotkeyHelpGroup[] = [
  {
    title: "Navigation",
    entries: [
      { keys: "j / k", description: "Move focus down / up in the sender list" },
      { keys: "g g", description: "Jump to first sender" },
      { keys: "G", description: "Jump to last sender" },
      { keys: "/", description: "Focus search" },
      { keys: "esc", description: "Clear search / close detail" },
    ],
  },
  {
    title: "Actions on focused sender",
    entries: [
      {
        keys: "e",
        description: "Edit — cycle action (trash → archive → keep → review)",
      },
      {
        keys: "x",
        description: "Apply retroactively… (opens confirmation modal)",
      },
      { keys: "?", description: "Toggle this help overlay" },
    ],
  },
];

const ACTION_CYCLE: SenderAction[] = [
  "auto_trash",
  "auto_archive",
  "always_keep",
  "review",
];

export function Decisions() {
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState<SenderAction | "all">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<SenderDecision | null>(null);
  const [newSender, setNewSender] = useState("");
  const [bulkAction, setBulkAction] = useState<SenderAction>("auto_trash");
  const [pending, setPending] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [applyRetroSignal, setApplyRetroSignal] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (actionFilter !== "all") query.set("action", actionFilter);
  query.set("limit", "200");
  const url = `/api/sender-decisions?${query.toString()}`;

  const { data, error, isLoading, mutate } =
    useSWR<ListSenderDecisionsResponse>(url);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const focusedIndex = useMemo(() => {
    if (!focused) return -1;
    return items.findIndex((i) => i.senderEmail === focused.senderEmail);
  }, [focused, items]);

  function moveFocus(delta: number) {
    if (items.length === 0) return;
    const next =
      focusedIndex === -1
        ? delta > 0
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, focusedIndex + delta));
    setFocused(items[next] ?? null);
  }

  function cycleFocusedAction() {
    if (!focused) return;
    const idx = ACTION_CYCLE.indexOf(focused.action);
    const next = ACTION_CYCLE[(idx + 1) % ACTION_CYCLE.length];
    patchOne(focused.senderEmail, next);
  }

  useHotkeys(
    {
      j: () => moveFocus(1),
      k: () => moveFocus(-1),
      "g g": () => {
        if (items[0]) setFocused(items[0]);
      },
      G: () => {
        if (items.length) setFocused(items[items.length - 1] ?? null);
      },
      "/": () => searchRef.current?.focus(),
      "?": () => setHelpOpen((v) => !v),
      esc: () => {
        if (search) setSearch("");
        else setFocused(null);
      },
      e: () => cycleFocusedAction(),
      x: () => {
        if (!focused) return;
        if (
          focused.action === "auto_trash" ||
          focused.action === "auto_archive" ||
          focused.action === "always_keep"
        ) {
          setApplyRetroSignal((n) => n + 1);
        }
      },
    },
    { enabled: !helpOpen },
  );

  // EL-374 — onboarding appears on the very first visit (no SenderDecision
  // rows yet) and only when no filters are narrowing the list. It's a one-
  // time nudge: once the user commits any decision, `total` flips > 0 and
  // the banner unmounts naturally.
  const showOnboarding =
    !isLoading &&
    !error &&
    total === 0 &&
    !onboardingDismissed &&
    !search &&
    actionFilter === "all";

  const allSelected = useMemo(
    () => items.length > 0 && items.every((i) => selected.has(i.senderEmail)),
    [items, selected],
  );

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((i) => i.senderEmail)));
    }
  }

  function toggleOne(email: string) {
    const next = new Set(selected);
    if (next.has(email)) next.delete(email);
    else next.add(email);
    setSelected(next);
  }

  async function patchOne(senderEmail: string, action: SenderAction) {
    setPending(true);
    try {
      const res = await fetch(
        `/api/sender-decisions/${encodeURIComponent(senderEmail)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      toastSuccess({ description: `Set to ${action}` });
      await mutate();
    } catch (err) {
      toastError({ description: String(err) });
    } finally {
      setPending(false);
    }
  }

  async function addNew() {
    const v = newSender.trim();
    if (!v) return;
    setPending(true);
    try {
      const res = await fetch("/api/sender-decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderEmail: v, action: "review" }),
      });
      if (!res.ok) throw new Error(await res.text());
      setNewSender("");
      toastSuccess({ description: `Added ${v}` });
      await mutate();
    } catch (err) {
      toastError({ description: String(err) });
    } finally {
      setPending(false);
    }
  }

  async function applyBulk() {
    if (selected.size === 0) return;
    setPending(true);
    try {
      const res = await fetch("/api/sender-decisions/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderEmails: Array.from(selected),
          action: bulkAction,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      toastSuccess({
        description: `${json.updated} updated, ${json.skipped} skipped`,
      });
      setSelected(new Set());
      await mutate();
    } catch (err) {
      toastError({ description: String(err) });
    } finally {
      setPending(false);
    }
  }

  return (
    <PageWrapper>
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <PageHeading>Decisions</PageHeading>
          <div className="text-sm text-muted-foreground">
            Per-sender triage policy. {total} senders tracked.
          </div>
        </div>
        <DecisionsCsvToolbar onImported={() => mutate()} />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
          <SearchIcon className="size-4 text-muted-foreground" />
          <Input
            ref={searchRef}
            placeholder="Search email or domain ( / )"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          value={actionFilter}
          onValueChange={(v) => setActionFilter(v as SenderAction | "all")}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {ACTION_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2 ml-auto">
          <Input
            placeholder="Add sender (email@domain)"
            value={newSender}
            onChange={(e) => setNewSender(e.target.value)}
            className="w-[260px]"
          />
          <Button
            size="sm"
            onClick={addNew}
            disabled={pending || !newSender.trim()}
          >
            Add
          </Button>
        </div>
      </div>

      {showOnboarding ? (
        <DecisionsOnboarding
          onDone={async () => {
            setOnboardingDismissed(true);
            await mutate();
          }}
        />
      ) : null}

      {selected.size > 0 ? (
        <div className="flex items-center gap-2 mb-4 p-2 bg-muted rounded">
          <div className="text-sm">{selected.size} selected</div>
          <Select
            value={bulkAction}
            onValueChange={(v) => setBulkAction(v as SenderAction)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  Set to {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={applyBulk} disabled={pending}>
            {pending ? (
              <Loader2Icon className="size-4 animate-spin mr-2" />
            ) : null}
            Apply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border rounded overflow-hidden">
          <LoadingContent loading={isLoading} error={error}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                  <TableHead>Sender</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead className="text-right">#</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow
                    key={item.id}
                    data-state={
                      focused?.senderEmail === item.senderEmail
                        ? "selected"
                        : undefined
                    }
                    className="cursor-pointer"
                    onClick={() => setFocused(item)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(item.senderEmail)}
                        onCheckedChange={() => toggleOne(item.senderEmail)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <div className="truncate max-w-[260px]">
                        {item.senderEmail}
                      </div>
                      <div className="text-muted-foreground text-[10px]">
                        {item.senderDomain} · {item.source}
                      </div>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Select
                        value={item.action}
                        onValueChange={(v) =>
                          patchOne(item.senderEmail, v as SenderAction)
                        }
                      >
                        <SelectTrigger className="w-[140px] h-7">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ACTION_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {item.messageCount}
                    </TableCell>
                  </TableRow>
                ))}
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-center text-sm text-muted-foreground py-8"
                    >
                      <InboxIcon className="size-8 mx-auto mb-2" />
                      No senders match.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </LoadingContent>
        </div>

        <div className="border rounded min-h-[400px]">
          <DecisionDetail
            decision={focused}
            onActionChange={(action) => {
              if (focused) patchOne(focused.senderEmail, action);
            }}
            applyRetroSignal={applyRetroSignal}
          />
        </div>
      </div>

      <HotkeyHelpOverlay
        open={helpOpen}
        onOpenChange={setHelpOpen}
        groups={HOTKEY_HELP}
      />
    </PageWrapper>
  );
}
