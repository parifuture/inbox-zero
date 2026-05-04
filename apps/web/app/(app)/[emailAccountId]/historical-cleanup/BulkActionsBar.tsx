"use client";

import { useState } from "react";
import { ArchiveIcon, SkipForwardIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type SelectedSenderSummary = {
  senderEmail: string;
  count: number;
};

export function BulkActionsBar({
  selectedSenders,
  onArchive,
  onSkip,
  onClear,
  isWorking,
}: {
  selectedSenders: SelectedSenderSummary[];
  onArchive: () => void;
  onSkip: () => void;
  onClear: () => void;
  isWorking: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const selectedCount = selectedSenders.length;

  if (selectedCount === 0) return null;

  // EL-323 blocker: confirmation modal shows sample senders + total thread
  // count before any Gmail mutation. "Archive N threads" is only reachable
  // from inside the dialog.
  const totalThreads = selectedSenders.reduce((sum, s) => sum + s.count, 0);
  const samples = selectedSenders.slice(0, 5);
  const remaining = Math.max(0, selectedCount - samples.length);

  return (
    <>
      <div className="sticky bottom-0 left-0 right-0 z-10 mt-3 border rounded-lg bg-background shadow-lg p-3 flex items-center justify-between gap-3">
        <div className="text-sm">
          <strong>{selectedCount}</strong> sender
          {selectedCount === 1 ? "" : "s"} selected
          <span className="text-muted-foreground ml-2">
            (~{totalThreads} threads)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={isWorking}
          >
            <ArchiveIcon className="size-4 mr-2" />
            Archive Selected ({selectedCount})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onSkip}
            disabled={isWorking}
          >
            <SkipForwardIcon className="size-4 mr-2" />
            Skip Selected
          </Button>
          <Button variant="ghost" size="sm" onClick={onClear}>
            <XIcon className="size-4 mr-1" />
            Clear
          </Button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Archive ~{totalThreads} thread{totalThreads === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              You're about to remove the Inbox label from every message matching{" "}
              <code>from:&lt;sender&gt; before:2024/01/01</code> for the{" "}
              {selectedCount} selected sender
              {selectedCount === 1 ? "" : "s"}. Gmail query filters exclude{" "}
              <code>in:sent</code> and <code>in:trash</code> — your sent mail
              and already-trashed mail are never touched. Messages are archived,
              not deleted; you can still find them via search.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2">
            <div className="text-xs text-muted-foreground mb-1">
              Sample senders:
            </div>
            <ul className="text-xs font-mono space-y-0.5 max-h-40 overflow-auto border rounded p-2 bg-muted/30">
              {samples.map((s) => (
                <li
                  key={s.senderEmail}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate">{s.senderEmail}</span>
                  <span className="text-muted-foreground shrink-0">
                    {s.count} thread{s.count === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
              {remaining > 0 ? (
                <li className="text-muted-foreground italic">
                  …and {remaining} more
                </li>
              ) : null}
            </ul>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={isWorking}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                onArchive();
              }}
              disabled={isWorking}
            >
              Archive {totalThreads} thread{totalThreads === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
