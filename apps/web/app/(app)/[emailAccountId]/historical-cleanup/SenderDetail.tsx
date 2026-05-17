"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArchiveIcon,
  InboxIcon,
  MailIcon,
  MessageCircleIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  AlertTriangleIcon,
} from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { useChat } from "@/providers/ChatProvider";
import type { MessageContext } from "@/app/api/chat/validation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadingContent } from "@/components/LoadingContent";
import { useSenderMessages } from "./hooks";
import type { Sender } from "./types";

function formatDateHeader(date: string | null) {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatCacheAge(fetchedAt: string | undefined): string | null {
  if (!fetchedAt) return null;
  const then = new Date(fetchedAt);
  if (Number.isNaN(then.getTime())) return null;
  const deltaMs = Date.now() - then.getTime();
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  const days = Math.floor(hours / 24);
  return `${days}d old`;
}

function LabelStateBadge({
  state,
}: {
  state: "inbox" | "archived" | "trashed" | "sent";
}) {
  if (state === "inbox") {
    return (
      <Badge variant="secondary" className="gap-1">
        <InboxIcon className="size-3" />
        Inbox
      </Badge>
    );
  }
  if (state === "trashed") {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <Trash2Icon className="size-3" />
        Trash
      </Badge>
    );
  }
  if (state === "sent") {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <SendIcon className="size-3" />
        Sent
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <ArchiveIcon className="size-3" />
      Archived
    </Badge>
  );
}

export function SenderDetail({
  sender,
  onArchive,
  onDelete,
  isArchiving,
  isDeleting,
  autoOpenChatForSenderEmail = null,
}: {
  sender: Sender | null;
  onArchive: (senderEmails: string[]) => void;
  onDelete: (senderEmails: string[]) => void;
  isArchiving: boolean;
  isDeleting: boolean;
  /**
   * EL-450 deep-link: when set to a sender email that matches the currently
   * selected sender, auto-opens the sender-rule chat once messages have
   * loaded. Set by HistoricalCleanup from the `?openChat=true` query param.
   */
  autoOpenChatForSenderEmail?: string | null;
}) {
  const [bypassCache, setBypassCache] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [accumulated, setAccumulated] = useState<
    {
      id: string;
      threadId: string;
      date: string | null;
      subject: string;
      snippet: string;
      labelState?: "inbox" | "archived" | "trashed" | "sent";
      inbox?: boolean;
    }[]
  >([]);
  const { data, error, isLoading, isValidating, mutate } = useSenderMessages(
    sender?.senderEmail ?? null,
    { bypassCache, cursor },
  );

  // EL-450: per-sender AI rule chat. Seeds ChatProvider with a `sender-rule`
  // MessageContext (EL-449) and opens the chat sidebar. The resulting Rule
  // will be sender-locked server-side (EL-452).
  const { setOpen } = useSidebar();
  const { setContext, setInput, setNewChat } = useChat();

  const handleCreateRuleChat = () => {
    if (!sender) return;
    const samples = (accumulated.length ? accumulated : (data?.messages ?? []))
      .slice(0, 20)
      .map((m) => ({
        subject: m.subject ?? "(no subject)",
        snippet: (m.snippet ?? "").slice(0, 500),
      }));
    // Best-effort: collapse labelStates to a stable de-duplicated list. This
    // is a coarse approximation of "existing Gmail labels" until we surface
    // real label-name data from Gmail (follow-up).
    const existingLabels = Array.from(
      new Set(
        (accumulated.length ? accumulated : (data?.messages ?? []))
          .map((m) => m.labelState)
          .filter((v): v is NonNullable<typeof v> => Boolean(v)),
      ),
    );
    const context: MessageContext = {
      type: "sender-rule",
      senderEmail: sender.senderEmail,
      sampleMessages: samples,
      existingLabels,
    };
    setNewChat();
    setContext(context);
    setInput(
      `Help me write a rule for mail from ${sender.senderEmail}. ` +
        "Walk me through the options based on what they actually send me.",
    );
    setOpen((arr) => [...arr, "chat-sidebar"]);
  };

  // EL-450: auto-open the chat when arriving via deep-link
  // (?sender=<email>&openChat=true). Wait until at least the first page of
  // sender messages has loaded so the seeded sampleMessages are not empty.
  const autoOpenedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoOpenChatForSenderEmail) return;
    if (!sender) return;
    if (
      sender.senderEmail.toLowerCase() !==
      autoOpenChatForSenderEmail.toLowerCase()
    )
      return;
    if (autoOpenedForRef.current === sender.senderEmail) return;
    if (!data && accumulated.length === 0) return; // wait for messages
    autoOpenedForRef.current = sender.senderEmail;
    handleCreateRuleChat();
    // handleCreateRuleChat is stable for the duration of this sender (closes
    // over current sender + accumulated/data), but lint doesn't know that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenChatForSenderEmail, sender?.senderEmail, data, accumulated]);

  // Reset accumulator when the selected sender changes.
  const lastSenderRef = useRef<string | null>(null);
  useEffect(() => {
    const next = sender?.senderEmail ?? null;
    if (lastSenderRef.current !== next) {
      lastSenderRef.current = next;
      setCursor(null);
      setAccumulated([]);
      setBypassCache(false);
    }
  }, [sender?.senderEmail]);

  // When new page data arrives, fold it into the accumulator.
  useEffect(() => {
    if (!data) return;
    if (cursor === null) {
      setAccumulated(data.messages);
    } else {
      setAccumulated((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const additions = data.messages.filter((m) => !seen.has(m.id));
        return additions.length ? [...prev, ...additions] : prev;
      });
    }
  }, [data, cursor]);

  if (!sender) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <MailIcon className="size-10 text-muted-foreground mb-3" />
        <div className="text-sm text-muted-foreground">
          Select a sender to view their full email history.
        </div>
      </div>
    );
  }

  const cacheAge = formatCacheAge(data?.fetchedAt);

  const handleRefresh = () => {
    setBypassCache(true);
    setCursor(null);
    setAccumulated([]);
    mutate();
  };

  const handleLoadMore = () => {
    if (data?.nextPageToken) {
      setBypassCache(false);
      setCursor(data.nextPageToken);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="border-b p-4 flex items-start justify-between gap-4">
        <div>
          <div className="font-semibold text-base">
            {sender.senderName || sender.senderEmail}
          </div>
          <div className="text-sm text-muted-foreground">
            {sender.senderEmail}
          </div>
          <div className="flex gap-2 mt-2 text-xs items-center flex-wrap">
            <Badge variant="secondary">{sender.count} emails</Badge>
            {sender.domain ? (
              <Badge variant="outline">{sender.domain}</Badge>
            ) : null}
            {sender.archivedAt ? (
              <Badge variant="outline">Archived</Badge>
            ) : null}
            {sender.skippedAt ? <Badge variant="outline">Skipped</Badge> : null}
            {data?.fromCache && cacheAge ? (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                Cached • {cacheAge}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isValidating}
            title="Force a fresh Gmail fetch"
          >
            <RefreshCwIcon
              className={`size-4 mr-2 ${isValidating ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCreateRuleChat}
            title="Open AI chat to create a rule scoped to this sender"
          >
            <MessageCircleIcon className="size-4 mr-2" />
            Create rule for this sender
          </Button>
          <Button
            size="sm"
            onClick={() => onArchive([sender.senderEmail])}
            disabled={isArchiving}
          >
            <ArchiveIcon className="size-4 mr-2" />
            Archive all
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              if (sender.count >= 10) {
                setConfirmDeleteOpen(true);
              } else {
                onDelete([sender.senderEmail]);
              }
            }}
            disabled={isDeleting}
            title="Move all of this sender's emails to Trash. Recoverable for 30 days in Gmail."
          >
            <Trash2Icon className="size-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move {sender.count.toLocaleString()} emails to Trash?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will move every email from{" "}
              <span className="font-mono">{sender.senderEmail}</span> to Gmail
              Trash. Gmail keeps trashed mail for 30 days, so you can recover
              anything by going to Gmail → Trash. Sent and starred emails are
              never touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDeleteOpen(false);
                onDelete([sender.senderEmail]);
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {data?.partial ? (
        <div className="px-4 py-2 text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 border-b flex items-center gap-2">
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          Partial results — Gmail throttled us. Try again in a minute.
        </div>
      ) : null}

      <div className="flex-1 overflow-auto">
        <LoadingContent
          loading={isLoading && accumulated.length === 0}
          error={error}
        >
          {accumulated.length === 0 ? (
            <div className="p-8 text-sm text-muted-foreground text-center">
              No messages found from this sender.
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">Date</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead className="w-28">Where</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accumulated.map((msg) => (
                    <TableRow key={msg.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {formatDateHeader(msg.date)}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium truncate max-w-[420px]">
                          {msg.subject || "(no subject)"}
                        </div>
                        <div className="text-xs text-muted-foreground truncate max-w-[480px]">
                          {msg.snippet}
                        </div>
                      </TableCell>
                      <TableCell>
                        <LabelStateBadge
                          state={
                            msg.labelState ?? (msg.inbox ? "inbox" : "archived")
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data?.nextPageToken ? (
                <div className="p-4 text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleLoadMore}
                    disabled={isValidating}
                  >
                    {isValidating ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </LoadingContent>
      </div>
    </div>
  );
}
