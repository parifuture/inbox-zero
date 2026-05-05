"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export interface HotkeyHelpEntry {
  description: string;
  keys: string; // e.g. "j / k", "g g", "?"
}

export interface HotkeyHelpGroup {
  entries: HotkeyHelpEntry[];
  title: string;
}

export function HotkeyHelpOverlay({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  groups: HotkeyHelpGroup[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Scoped to this page. Press{" "}
            <kbd className="px-1 border rounded text-[10px]">?</kbd> any time to
            toggle.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.title}>
              <div className="text-xs font-semibold text-muted-foreground mb-2">
                {group.title}
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                {group.entries.map((entry) => (
                  <Row key={entry.keys} entry={entry} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ entry }: { entry: HotkeyHelpEntry }) {
  return (
    <>
      <div className="font-mono">
        {entry.keys.split(" / ").map((seg, i, arr) => (
          <span key={seg}>
            {seg.split(" ").map((k, j, karr) => (
              <span key={`${k}-${j}`}>
                <kbd className="px-1.5 py-0.5 border rounded bg-muted text-xs">
                  {k}
                </kbd>
                {j < karr.length - 1 ? (
                  <span className="mx-1 text-muted-foreground">then</span>
                ) : null}
              </span>
            ))}
            {i < arr.length - 1 ? (
              <span className="mx-2 text-muted-foreground">or</span>
            ) : null}
          </span>
        ))}
      </div>
      <div>{entry.description}</div>
    </>
  );
}
