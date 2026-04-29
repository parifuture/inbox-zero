import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getGmailClientForEmail } from "@/utils/email-account-client";
import { scanHistoricalSenders } from "@/app/api/historical-senders/scan-runner";

const CUTOFF_DATE = new Date("2024-01-01T00:00:00.000Z");

export type HistoricalScanResponse =
  | { status: "idle" }
  | {
      id: string;
      status: "running" | "completed" | "error";
      progress: number;
      totalEstimate: number | null;
      error: string | null;
      startedAt: string | null;
      completedAt: string | null;
      cutoffDate: string;
    };

function serializeScan(
  scan: NonNullable<
    Awaited<ReturnType<typeof prisma.historicalSenderScan.findUnique>>
  >,
): Exclude<HistoricalScanResponse, { status: "idle" }> {
  return {
    id: scan.id,
    status: scan.status as "running" | "completed" | "error",
    progress: scan.progress,
    totalEstimate: scan.totalEstimate ?? null,
    error: scan.error ?? null,
    startedAt: scan.startedAt?.toISOString() ?? null,
    completedAt: scan.completedAt?.toISOString() ?? null,
    cutoffDate: scan.cutoffDate.toISOString(),
  };
}

export const GET = withEmailProvider(
  "historical-senders/scan",
  async (request) => {
    const { emailAccountId } = request.auth;
    const scan = await prisma.historicalSenderScan.findUnique({
      where: { emailAccountId },
    });
    if (!scan) {
      return NextResponse.json({
        status: "idle",
      } satisfies HistoricalScanResponse);
    }
    return NextResponse.json(
      serializeScan(scan) satisfies HistoricalScanResponse,
    );
  },
);

export const POST = withEmailProvider(
  "historical-senders/scan",
  async (request) => {
    const { emailAccountId } = request.auth;
    const { emailProvider, logger } = request;

    if (!isGoogleProvider(emailProvider.name)) {
      return NextResponse.json(
        {
          error: "Historical cleanup is only supported for Gmail accounts.",
          isKnownError: true,
        },
        { status: 400 },
      );
    }

    const existing = await prisma.historicalSenderScan.findUnique({
      where: { emailAccountId },
    });

    if (existing && existing.status === "running") {
      return NextResponse.json(
        serializeScan(existing) satisfies HistoricalScanResponse,
      );
    }

    const scan = await prisma.historicalSenderScan.upsert({
      where: { emailAccountId },
      create: {
        emailAccountId,
        status: "running",
        progress: 0,
        startedAt: new Date(),
        cutoffDate: CUTOFF_DATE,
      },
      update: {
        status: "running",
        progress: 0,
        totalEstimate: null,
        error: null,
        startedAt: new Date(),
        completedAt: null,
        cutoffDate: CUTOFF_DATE,
      },
    });

    const gmail = await getGmailClientForEmail({ emailAccountId, logger });

    // Fire and forget — scan runs asynchronously and updates the scan row.
    scanHistoricalSenders({
      emailAccountId,
      gmail,
      cutoffDate: CUTOFF_DATE,
    }).catch((error) => {
      logger.error("Background historical scan threw", { error });
    });

    return NextResponse.json(
      serializeScan(scan) satisfies HistoricalScanResponse,
    );
  },
);
