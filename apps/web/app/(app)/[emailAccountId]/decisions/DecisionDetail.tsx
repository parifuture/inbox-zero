"use client";

import { useState } from "react";
import useSWR from "swr";
import { ArchiveIcon, MailIcon } from "lucide-react";
import type { SenderAction } from "@/generated/prisma/enums";
import type { SenderDecision } from "@/generated/prisma/client";
import type { SenderMessagesResponse } from "@/app/api/sender-decisions/[senderEmail]/messages/route";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingContent } from "@/components/LoadingContent";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { toastInfo } from "@/components/Toast";

const ACTION_LABELS: Record<SenderAction, string> = {
  auto_trash: "Auto-trash",
  auto_archive: "Auto-archive",
  always_keep: "Always keep",
  review: "Review",
};

export function DecisionDetail({
  decision,
  onActionChange,
}: {
  decision: SenderDecision | null;
  onActionChange: (action: SenderAction) => void;
}) {
  const [retroOpen, setRetroOpen] = useState(false);

  const { data, error, isLoading } = useSWR<SenderMessagesResponse>(
    decision
      ? `/api/sender-decisions/${encodeURIComponent(decision.senderEmail)}/messages?limit=50`
      : null,
  );

  if (!decision) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <MailIcon className="size-10 text-muted-foreground mb-3" />
        <div className="text-sm text-muted-foreground">
          Select a sender to view their messages and change the decision.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b p-4">
        <div className="font-semibold text-base font-mono">
          {decision.senderEmail}
        </div>
        <div className="flex items-center gap-2 mt-2 text-xs">
          <Badge variant="outline">{decision.senderDomain}</Badge>
          <Badge variant="secondary">{decision.messageCount} emails</Badge>
          <Badge variant="outline">source: {decision.source}</Badge>
          {decision.autoAppliedAt ? (
            <Badge variant="outline">
              applied {new Date(decision.autoAppliedAt).toLocaleDateString()}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <Select
            value={decision.action}
            onValueChange={(v) => onActionChange(v as SenderAction)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ACTION_LABELS) as SenderAction[]).map((a) => (
                <SelectItem key={a} value={a}>
                  {ACTION_LABELS[a]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {decision.action === "auto_trash" ||
          decision.action === "auto_archive" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRetroOpen(true)}
            >
              Apply retroactively…
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <LoadingContent loading={isLoading} error={error}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="w-16 text-right">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.items ?? []).map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="text-xs whitespace-nowrap">
                    {new Date(m.date).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="truncate max-w-[320px]">
                      {/* EmailMessage has no subject column in this fork yet */}
                      {m.messageId}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {m.inbox ? (
                      <MailIcon className="size-3 inline" />
                    ) : (
                      <ArchiveIcon className="size-3 inline" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {data && data.items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center text-sm text-muted-foreground py-8"
                  >
                    No local messages from this sender yet.
                    {data.source === "local"
                      ? " (gmail-mirror fallback pending.)"
                      : null}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </LoadingContent>
      </div>

      <Dialog open={retroOpen} onOpenChange={setRetroOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply retroactively?</DialogTitle>
            <DialogDescription>
              {decision.action === "auto_trash"
                ? `Trash ~${decision.messageCount} existing emails from ${decision.senderEmail}?`
                : `Archive ~${decision.messageCount} existing emails from ${decision.senderEmail}?`}{" "}
              This uses Gmail trash (30-day recovery), never permanent delete.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRetroOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                // Backlog applier is implemented in a follow-up ticket (EL-357).
                // This button just records intent for now.
                toastInfo({
                  title: "Decision saved",
                  description:
                    "Backlog applier not wired yet — see EL-357. The decision will be applied when the applier runs.",
                });
                setRetroOpen(false);
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
