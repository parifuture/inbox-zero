"use client";

import { useState } from "react";
import {
  ArchiveIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
  SearchIcon,
  SkipForwardIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingContent } from "@/components/LoadingContent";
import { cn } from "@/utils";
import type {
  Sender,
  SenderSortKey,
  SenderSortOrder,
  SenderStatusFilter,
} from "./types";

const STATUS_FILTERS: { value: SenderStatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "skipped", label: "Skipped" },
  { value: "all", label: "All" },
];

const SORT_OPTIONS: {
  value: SenderSortKey;
  label: string;
}[] = [
  { value: "count", label: "Email count" },
  { value: "lastDate", label: "Last received" },
  { value: "firstDate", label: "First received" },
];

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function senderDisplayName(sender: Sender) {
  return sender.senderName || sender.senderEmail;
}

export function SenderList({
  senders,
  isLoading,
  error,
  total,
  search,
  onSearchChange,
  status,
  onStatusChange,
  sort,
  order,
  onSortChange,
  onOrderToggle,
  selectedRows,
  onToggleRow,
  onToggleAll,
  selectedRowEmail,
  onSelectRow,
  onArchive,
  onSkip,
  emptyMessage,
}: {
  senders: Sender[];
  isLoading: boolean;
  error: { error?: string } | undefined;
  total: number;
  search: string;
  onSearchChange: (value: string) => void;
  status: SenderStatusFilter;
  onStatusChange: (value: SenderStatusFilter) => void;
  sort: SenderSortKey;
  order: SenderSortOrder;
  onSortChange: (sort: SenderSortKey) => void;
  onOrderToggle: () => void;
  selectedRows: Set<string>;
  onToggleRow: (email: string) => void;
  onToggleAll: (allChecked: boolean) => void;
  selectedRowEmail: string | null;
  onSelectRow: (sender: Sender) => void;
  onArchive: (senderEmails: string[]) => void;
  onSkip: (senderEmails: string[]) => void;
  emptyMessage?: string;
}) {
  const [searchInput, setSearchInput] = useState(search);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearchChange(searchInput.trim());
  };

  const allChecked =
    senders.length > 0 && senders.every((s) => selectedRows.has(s.senderEmail));

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-col gap-3 p-3 border-b">
        <form onSubmit={handleSearchSubmit} className="relative">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search sender or domain…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-8"
          />
        </form>
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={status === f.value ? "default" : "outline"}
              onClick={() => onStatusChange(f.value)}
            >
              {f.label}
            </Button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  Sort: {SORT_OPTIONS.find((o) => o.value === sort)?.label}
                  <ChevronDownIcon className="size-4 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SORT_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => onSortChange(opt.value)}
                  >
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="outline" onClick={onOrderToggle}>
              {order === "desc" ? "Desc" : "Asc"}
            </Button>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          {total === 0
            ? "No senders"
            : `${total} sender${total === 1 ? "" : "s"}`}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <LoadingContent
          loading={isLoading && senders.length === 0}
          error={error}
        >
          {senders.length === 0 ? (
            <div className="p-8 text-sm text-muted-foreground text-center">
              {emptyMessage || "No senders match this filter."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={allChecked}
                      onCheckedChange={(checked) =>
                        onToggleAll(Boolean(checked))
                      }
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Sender</TableHead>
                  <TableHead className="text-right">Emails</TableHead>
                  <TableHead className="hidden md:table-cell">Last</TableHead>
                  <TableHead className="hidden lg:table-cell">First</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {senders.map((sender) => {
                  const checked = selectedRows.has(sender.senderEmail);
                  const isActive = selectedRowEmail === sender.senderEmail;
                  return (
                    <TableRow
                      key={sender.id}
                      className={cn("cursor-pointer", isActive && "bg-accent")}
                      onClick={() => onSelectRow(sender)}
                    >
                      <TableCell
                        className="w-8"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() =>
                            onToggleRow(sender.senderEmail)
                          }
                          aria-label={`Select ${sender.senderEmail}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium truncate max-w-[260px]">
                          {senderDisplayName(sender)}
                        </div>
                        <div className="text-xs text-muted-foreground flex gap-2 items-center">
                          <span className="truncate max-w-[260px]">
                            {sender.senderEmail}
                          </span>
                          {sender.domain ? (
                            <Badge variant="secondary" className="font-normal">
                              {sender.domain}
                            </Badge>
                          ) : null}
                          {sender.archivedAt ? (
                            <Badge variant="outline">Archived</Badge>
                          ) : null}
                          {sender.skippedAt ? (
                            <Badge variant="outline">Skipped</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {sender.count.toLocaleString()}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs">
                        {formatDate(sender.lastDate)}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs">
                        {formatDate(sender.firstDate)}
                      </TableCell>
                      <TableCell
                        className="text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label="Actions"
                            >
                              <MoreHorizontalIcon className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => onArchive([sender.senderEmail])}
                            >
                              <ArchiveIcon className="size-4 mr-2" />
                              Archive all
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => onSkip([sender.senderEmail])}
                            >
                              <SkipForwardIcon className="size-4 mr-2" />
                              Skip
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </LoadingContent>
      </div>
    </div>
  );
}
