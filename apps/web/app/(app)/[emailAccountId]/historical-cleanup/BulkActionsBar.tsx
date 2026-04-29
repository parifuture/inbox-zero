"use client";

import { ArchiveIcon, SkipForwardIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BulkActionsBar({
  selectedCount,
  onArchive,
  onSkip,
  onClear,
  isWorking,
}: {
  selectedCount: number;
  onArchive: () => void;
  onSkip: () => void;
  onClear: () => void;
  isWorking: boolean;
}) {
  if (selectedCount === 0) return null;

  return (
    <div className="sticky bottom-0 left-0 right-0 z-10 mt-3 border rounded-lg bg-background shadow-lg p-3 flex items-center justify-between gap-3">
      <div className="text-sm">
        <strong>{selectedCount}</strong> sender
        {selectedCount === 1 ? "" : "s"} selected
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={onArchive}
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
  );
}
