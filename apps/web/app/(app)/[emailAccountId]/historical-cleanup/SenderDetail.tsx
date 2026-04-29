"use client";

import { ArchiveIcon, InboxIcon, MailIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

export function SenderDetail({
  sender,
  onArchive,
  isArchiving,
}: {
  sender: Sender | null;
  onArchive: (senderEmails: string[]) => void;
  isArchiving: boolean;
}) {
  const { data, error, isLoading } = useSenderMessages(
    sender?.senderEmail ?? null,
  );

  if (!sender) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <MailIcon className="size-10 text-muted-foreground mb-3" />
        <div className="text-sm text-muted-foreground">
          Select a sender to view messages from before Jan 1 2024.
        </div>
      </div>
    );
  }

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
          <div className="flex gap-2 mt-2 text-xs items-center">
            <Badge variant="secondary">{sender.count} emails</Badge>
            {sender.domain ? (
              <Badge variant="outline">{sender.domain}</Badge>
            ) : null}
            {sender.archivedAt ? (
              <Badge variant="outline">Archived</Badge>
            ) : null}
            {sender.skippedAt ? <Badge variant="outline">Skipped</Badge> : null}
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => onArchive([sender.senderEmail])}
          disabled={isArchiving}
        >
          <ArchiveIcon className="size-4 mr-2" />
          Archive all
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        <LoadingContent loading={isLoading} error={error}>
          {!data?.messages.length ? (
            <div className="p-8 text-sm text-muted-foreground text-center">
              No messages found before Jan 1 2024.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Date</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead className="w-20">Inbox</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.messages.map((msg) => (
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
                      {msg.inbox ? (
                        <Badge variant="secondary" className="gap-1">
                          <InboxIcon className="size-3" />
                          Inbox
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Archived
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </LoadingContent>
      </div>
    </div>
  );
}
