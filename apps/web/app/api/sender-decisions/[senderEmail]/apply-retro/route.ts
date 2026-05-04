import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { canonicalizeSender } from "@/utils/sender-decision";
import {
  isApplierAction,
  scheduleBacklogJob,
  toJobSummary,
  type BacklogJobSummary,
} from "@/utils/sender-decision/backlog-applier";

export type ApplyRetroResponse = { job: BacklogJobSummary };
export type ApplyRetroStatusResponse = { job: BacklogJobSummary | null };

function decodeSenderParam(raw: string): string {
  return canonicalizeSender(decodeURIComponent(raw));
}

export const POST = withEmailAccount(
  "sender-decisions/apply-retro/post",
  async (request, { params }) => {
    const emailAccountId = request.auth.emailAccountId;
    const { senderEmail: rawSender } = await params;
    const canonical = decodeSenderParam(rawSender);
    if (!canonical) {
      return NextResponse.json(
        { error: "Invalid sender email" },
        { status: 400 },
      );
    }

    const decision = await prisma.senderDecision.findUnique({
      where: {
        emailAccountId_senderEmail: { emailAccountId, senderEmail: canonical },
      },
    });

    if (!decision) {
      return NextResponse.json(
        { error: "Decision not found" },
        { status: 404 },
      );
    }

    if (!isApplierAction(decision.action)) {
      return NextResponse.json(
        {
          error:
            "Cannot apply retroactively to a 'review' sender. Set auto_trash / auto_archive / always_keep first.",
        },
        { status: 400 },
      );
    }

    // Dedupe: if there's already a running/pending job for this sender, hand
    // the existing one back instead of spawning a duplicate worker.
    const existing = await prisma.senderDecisionJob.findFirst({
      where: {
        emailAccountId,
        senderEmail: canonical,
        status: { in: ["pending", "running"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      return NextResponse.json<ApplyRetroResponse>({
        job: toJobSummary(existing),
      });
    }

    const job = await prisma.senderDecisionJob.create({
      data: {
        emailAccountId,
        senderEmail: canonical,
        action: decision.action,
        status: "pending",
      },
    });

    scheduleBacklogJob(job.id, request.logger);

    return NextResponse.json<ApplyRetroResponse>({ job: toJobSummary(job) });
  },
);

export const GET = withEmailAccount(
  "sender-decisions/apply-retro/get",
  async (request, { params }) => {
    const emailAccountId = request.auth.emailAccountId;
    const { senderEmail: rawSender } = await params;
    const canonical = decodeSenderParam(rawSender);
    if (!canonical) {
      return NextResponse.json(
        { error: "Invalid sender email" },
        { status: 400 },
      );
    }

    const job = await prisma.senderDecisionJob.findFirst({
      where: { emailAccountId, senderEmail: canonical },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json<ApplyRetroStatusResponse>({
      job: job ? toJobSummary(job) : null,
    });
  },
);
