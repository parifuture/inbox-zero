"use client";

import useSWR from "swr";
import { useCallback } from "react";
import { toast } from "sonner";
import type {
  HistoricalSendersResponse,
  HistoricalSenderItem,
} from "@/app/api/historical-senders/route";
import type { HistoricalScanResponse } from "@/app/api/historical-senders/scan/route";
import type { HistoricalSenderMessagesResponse } from "@/app/api/historical-senders/[senderEmail]/messages/route";
import type { HistoricalSendersArchiveResponse } from "@/app/api/historical-senders/archive/route";
import type { HistoricalSendersSkipResponse } from "@/app/api/historical-senders/skip/route";
import { fetchWithAccount } from "@/utils/fetch";
import { useAccount } from "@/providers/EmailAccountProvider";
import type { HistoricalSendersListParams } from "./types";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed with ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function buildSendersUrl(params: HistoricalSendersListParams) {
  const search = new URLSearchParams();
  if (params.search) search.set("search", params.search);
  search.set("status", params.status);
  search.set("sort", params.sort);
  search.set("order", params.order);
  search.set("minCount", String(params.minCount));
  search.set("limit", String(params.limit));
  search.set("offset", String(params.offset));
  return `/api/historical-senders?${search.toString()}`;
}

export function useScanStatus(refreshInterval: number) {
  const { emailAccountId } = useAccount();
  return useSWR<HistoricalScanResponse>(
    emailAccountId ? ["/api/historical-senders/scan", emailAccountId] : null,
    async ([url]) => {
      const res = await fetchWithAccount({
        url: url as string,
        emailAccountId,
      });
      return jsonOrThrow<HistoricalScanResponse>(res);
    },
    { refreshInterval, keepPreviousData: true },
  );
}

export function useStartScan() {
  const { emailAccountId } = useAccount();

  return useCallback(async () => {
    const res = await fetchWithAccount({
      url: "/api/historical-senders/scan",
      emailAccountId,
      init: { method: "POST" },
    });
    return jsonOrThrow<HistoricalScanResponse>(res);
  }, [emailAccountId]);
}

export function useHistoricalSenders(params: HistoricalSendersListParams) {
  const { emailAccountId } = useAccount();
  const url = buildSendersUrl(params);

  return useSWR<HistoricalSendersResponse>(
    emailAccountId ? [url, emailAccountId] : null,
    async ([u]) => {
      const res = await fetchWithAccount({
        url: u as string,
        emailAccountId,
      });
      return jsonOrThrow<HistoricalSendersResponse>(res);
    },
    { keepPreviousData: true },
  );
}

export function useSenderMessages(senderEmail: string | null) {
  const { emailAccountId } = useAccount();
  const url = senderEmail
    ? `/api/historical-senders/${encodeURIComponent(senderEmail)}/messages`
    : null;

  return useSWR<HistoricalSenderMessagesResponse>(
    senderEmail && emailAccountId ? [url, emailAccountId] : null,
    async ([u]) => {
      const res = await fetchWithAccount({
        url: u as string,
        emailAccountId,
      });
      return jsonOrThrow<HistoricalSenderMessagesResponse>(res);
    },
    { keepPreviousData: true },
  );
}

export function useArchiveSenders() {
  const { emailAccountId } = useAccount();

  return useCallback(
    async (senderEmails: string[]) => {
      if (senderEmails.length === 0) return null;
      const promise = (async () => {
        const res = await fetchWithAccount({
          url: "/api/historical-senders/archive",
          emailAccountId,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ senderEmails }),
          },
        });
        return jsonOrThrow<HistoricalSendersArchiveResponse>(res);
      })();

      toast.promise(promise, {
        loading: `Archiving ${senderEmails.length} sender${
          senderEmails.length === 1 ? "" : "s"
        }…`,
        success: (data) => {
          const total = data.archived.reduce((acc, s) => acc + s.count, 0);
          return `Archived ${total} email${total === 1 ? "" : "s"}`;
        },
        error: (err) =>
          err instanceof Error ? err.message : "Failed to archive senders",
      });

      try {
        return await promise;
      } catch {
        return null;
      }
    },
    [emailAccountId],
  );
}

export function useSkipSenders() {
  const { emailAccountId } = useAccount();

  return useCallback(
    async (senderEmails: string[]) => {
      if (senderEmails.length === 0) return null;
      const promise = (async () => {
        const res = await fetchWithAccount({
          url: "/api/historical-senders/skip",
          emailAccountId,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ senderEmails }),
          },
        });
        return jsonOrThrow<HistoricalSendersSkipResponse>(res);
      })();

      toast.promise(promise, {
        loading: `Skipping ${senderEmails.length} sender${
          senderEmails.length === 1 ? "" : "s"
        }…`,
        success: (data) =>
          `Skipped ${data.skipped} sender${data.skipped === 1 ? "" : "s"}`,
        error: (err) =>
          err instanceof Error ? err.message : "Failed to skip senders",
      });

      try {
        return await promise;
      } catch {
        return null;
      }
    },
    [emailAccountId],
  );
}

export type { HistoricalSenderItem };
