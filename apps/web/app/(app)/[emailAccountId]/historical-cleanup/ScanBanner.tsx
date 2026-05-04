"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2Icon, RefreshCwIcon, AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useScanStatus, useStartScan } from "./hooks";

const RUNNING_REFRESH_MS = 3000;
const IDLE_REFRESH_MS = 0;

function formatNumber(n: number) {
  return n.toLocaleString();
}

export function ScanBanner({
  onScanCompleted,
}: {
  onScanCompleted?: () => void;
}) {
  const [starting, setStarting] = useState(false);
  // Poll while running OR while we're optimistically starting a scan; otherwise idle.
  const previousStatus = useRef<string | null>(null);
  const [pollMs, setPollMs] = useState(IDLE_REFRESH_MS);
  const { data, mutate, isLoading } = useScanStatus(pollMs);
  const startScan = useStartScan();

  const status = data && "status" in data ? data.status : "idle";

  useEffect(() => {
    setPollMs(
      status === "running" || starting ? RUNNING_REFRESH_MS : IDLE_REFRESH_MS,
    );
    if (previousStatus.current === "running" && status !== "running") {
      onScanCompleted?.();
    }
    previousStatus.current = status;
  }, [status, starting, onScanCompleted]);

  const handleStart = async () => {
    setStarting(true);
    try {
      await startScan();
      await mutate();
    } finally {
      setStarting(false);
    }
  };

  if (isLoading && !data) {
    return null;
  }

  if (status === "running" && data && "progress" in data) {
    const total = data.totalEstimate ?? 0;
    const progress = data.progress;
    const percent =
      total > 0 ? Math.min(100, Math.round((progress / total) * 100)) : 0;

    return (
      <Card className="mb-4">
        <CardContent className="py-4 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            <span>
              Scanning inbox… processed{" "}
              <strong>{formatNumber(progress)}</strong>
              {total > 0 ? (
                <>
                  {" "}
                  of ~<strong>{formatNumber(total)}</strong>
                </>
              ) : null}{" "}
              messages from before Jan 1 2024.
            </span>
          </div>
          {total > 0 ? <Progress value={percent} /> : null}
        </CardContent>
      </Card>
    );
  }

  if (status === "error" && data && "error" in data) {
    return (
      <Card className="mb-4 border-destructive/40">
        <CardContent className="py-4 flex items-start justify-between gap-3">
          <div className="flex gap-2">
            <AlertTriangleIcon className="size-5 text-destructive mt-0.5" />
            <div className="text-sm">
              <div className="font-medium">Scan failed</div>
              <div className="text-muted-foreground break-words">
                {data.error || "Unknown error"}
              </div>
            </div>
          </div>
          <Button onClick={handleStart} size="sm" variant="outline">
            <RefreshCwIcon className="size-4 mr-2" />
            Retry scan
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (status === "completed" && data && "progress" in data) {
    return (
      <Card className="mb-4">
        <CardContent className="py-4 flex items-center justify-between gap-3">
          <div className="text-sm">
            Scan complete — found senders in{" "}
            <strong>{formatNumber(data.progress)}</strong> messages from before
            Jan 1 2024.
          </div>
          <Button onClick={handleStart} size="sm" variant="outline">
            <RefreshCwIcon className="size-4 mr-2" />
            Re-scan
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-4">
      <CardContent className="py-4 flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          Scan your inbox to find senders that emailed you before Jan 1 2024.
        </div>
        <Button onClick={handleStart} size="sm" disabled={starting}>
          {starting ? (
            <Loader2Icon className="size-4 mr-2 animate-spin" />
          ) : null}
          Scan inbox (before Jan 1 2024)
        </Button>
      </CardContent>
    </Card>
  );
}
