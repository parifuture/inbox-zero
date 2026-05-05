"use client";

/**
 * EL-375 — Export / Import CSV controls for the /decisions page.
 *
 * - "Export CSV" hits `GET /api/sender-decisions/export` and triggers a
 *   browser download (the route sets `Content-Disposition: attachment`).
 * - "Import CSV" opens a dialog. The user picks a file, the dialog calls
 *   `POST /api/sender-decisions/import` with `mode=dry-run` first to show a
 *   preview (creates / updates / skipped / errors). On Apply, it re-POSTs
 *   the same file with `mode=merge`.
 */

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  DownloadIcon,
  UploadIcon,
  Loader2Icon,
  AlertTriangleIcon,
} from "lucide-react";
import type { PostSenderDecisionsImportResponse } from "@/app/api/sender-decisions/import/route";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface DecisionsCsvToolbarProps {
  onImported?: () => void;
}

export function DecisionsCsvToolbar({ onImported }: DecisionsCsvToolbarProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] =
    useState<PostSenderDecisionsImportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setLoading(false);
    setApplying(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const postImport = async (
    f: File,
    mode: "dry-run" | "merge",
  ): Promise<PostSenderDecisionsImportResponse> => {
    const body = new FormData();
    body.set("file", f);
    body.set("mode", mode);
    const res = await fetch("/api/sender-decisions/import", {
      method: "POST",
      body,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as PostSenderDecisionsImportResponse;
  };

  const onFileChange = async (next: File | null) => {
    setFile(next);
    setPreview(null);
    if (!next) return;
    setLoading(true);
    try {
      const result = await postImport(next, "dry-run");
      setPreview(result);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to preview import");
    } finally {
      setLoading(false);
    }
  };

  const onApply = async () => {
    if (!file) return;
    setApplying(true);
    try {
      const result = await postImport(file, "merge");
      toast.success(
        `Applied: ${result.summary.creates} created, ${result.summary.updates} updated, ${result.summary.skipped} skipped`,
      );
      onImported?.();
      setOpen(false);
      reset();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to apply import");
    } finally {
      setApplying(false);
    }
  };

  const totalChanges =
    (preview?.summary.creates ?? 0) + (preview?.summary.updates ?? 0);
  const hasErrors = (preview?.summary.errors ?? 0) > 0;

  return (
    <div className="flex items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <a href="/api/sender-decisions/export" download>
          <DownloadIcon className="h-4 w-4" />
          <span className="ml-1">Export CSV</span>
        </a>
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <UploadIcon className="h-4 w-4" />
            <span className="ml-1">Import CSV</span>
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import sender decisions</DialogTitle>
            <DialogDescription>
              Upload a CSV with at minimum <code>senderEmail</code> and{" "}
              <code>action</code> columns. Never silently deletes — only adds or
              updates. Preview the diff before applying.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            />

            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="h-4 w-4 animate-spin" />
                Parsing and diffing…
              </div>
            )}

            {preview && (
              <div className="space-y-3">
                <div className="grid grid-cols-4 gap-2 text-center">
                  <SummaryPill label="Create" value={preview.summary.creates} />
                  <SummaryPill label="Update" value={preview.summary.updates} />
                  <SummaryPill label="Skip" value={preview.summary.skipped} />
                  <SummaryPill
                    label="Errors"
                    value={preview.summary.errors}
                    tone={hasErrors ? "error" : undefined}
                  />
                </div>

                {hasErrors && (
                  <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    <div className="flex items-center gap-2 font-medium text-destructive">
                      <AlertTriangleIcon className="h-4 w-4" />
                      Row-level errors
                    </div>
                    <ul className="mt-2 text-xs space-y-1 max-h-36 overflow-auto">
                      {preview.errors.slice(0, 50).map((err, idx) => (
                        <li key={idx}>
                          Row {err.row}
                          {err.field ? ` (${err.field})` : ""}: {err.message}
                          {err.raw ? ` — "${err.raw}"` : ""}
                        </li>
                      ))}
                      {preview.errors.length > 50 && (
                        <li className="text-muted-foreground">
                          …and {preview.errors.length - 50} more
                        </li>
                      )}
                    </ul>
                  </div>
                )}

                {preview.diff.updates.length > 0 && (
                  <DiffTable
                    title="Updates"
                    rows={preview.diff.updates.slice(0, 50).map((u) => ({
                      sender: u.senderEmail,
                      before: `${u.before.action} (${u.before.source})`,
                      after: `${u.after.action} (${u.after.source})`,
                    }))}
                    truncated={preview.diff.updates.length > 50}
                  />
                )}

                {preview.diff.creates.length > 0 && (
                  <DiffTable
                    title="Creates"
                    rows={preview.diff.creates.slice(0, 50).map((c) => ({
                      sender: c.senderEmail,
                      before: "—",
                      after: `${c.action} (user)`,
                    }))}
                    truncated={preview.diff.creates.length > 50}
                  />
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={onApply}
              disabled={!preview || totalChanges === 0 || applying}
            >
              {applying ? (
                <Loader2Icon className="h-4 w-4 animate-spin" />
              ) : null}
              <span className={applying ? "ml-1" : ""}>
                Apply {totalChanges > 0 ? `(${totalChanges})` : ""}
              </span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "error";
}) {
  return (
    <div
      className={`rounded border p-2 ${tone === "error" ? "border-destructive/40 bg-destructive/5" : "bg-muted/40"}`}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}

function DiffTable({
  title,
  rows,
  truncated,
}: {
  title: string;
  rows: { sender: string; before: string; after: string }[];
  truncated: boolean;
}) {
  return (
    <div>
      <div className="text-sm font-medium mb-1">{title}</div>
      <div className="max-h-48 overflow-auto rounded border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sender</TableHead>
              <TableHead>Before</TableHead>
              <TableHead>After</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${title}:${r.sender}`}>
                <TableCell
                  className="max-w-[260px] truncate text-xs"
                  title={r.sender}
                >
                  {r.sender}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.before}
                </TableCell>
                <TableCell className="text-xs">{r.after}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {truncated && (
        <div className="mt-1 text-xs text-muted-foreground">
          Showing first 50 rows.
        </div>
      )}
    </div>
  );
}
