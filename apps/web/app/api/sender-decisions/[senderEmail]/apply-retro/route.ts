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
import {
  evaluateApplyRetroGuard,
  getConfiguredThresholds,
  previewApplierBlastRadius,
} from "@/utils/sender-decision/apply-retro-guard";
import { getGmailClientForEmail } from "@/utils/email-account-client";

const MODULE = "sender-decisions.apply-retro";

export type ApplyRetroResponse = { job: BacklogJobSummary };
export type ApplyRetroStatusResponse = { job: BacklogJobSummary | null };
export type ApplyRetroPreviewResponse = {
  count: number;
  overHardCap: boolean;
  softCap: number;
  hardCap: number;
};

function decodeSenderParam(raw: string): string {
  return canonicalizeSender(decodeURIComponent(raw));
}

/**
 * Body shape for apply-retro POST.
 * - `confirm: true` + `expectedCount: <n>` required when preview > softCap.
 * - `confirm: true` + `override: true` required when preview > hardCap.
 * - `preview: true` (short-circuit) returns the preview without starting a job.
 */
type ApplyRetroBody = {
  confirm?: boolean;
  expectedCount?: number;
  override?: boolean;
  preview?: boolean;
};

async function readBody(request: Request): Promise<ApplyRetroBody> {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
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

    // Rate-limit: at most one in-flight apply-retro per EmailAccount.
    // A second request while another job is pending/running for ANY sender
    // on this account returns 429 with the existing job id.
    const inFlight = await prisma.senderDecisionJob.findFirst({
      where: {
        emailAccountId,
        status: { in: ["pending", "running"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (inFlight) {
      // Same sender? Hand back the existing job handle (idempotent).
      if (inFlight.senderEmail === canonical) {
        return NextResponse.json<ApplyRetroResponse>(
          { job: toJobSummary(inFlight) },
          { status: 200 },
        );
      }
      return NextResponse.json(
        {
          error:
            "Another apply-retro job is already running for this account. Wait for it to finish.",
          inFlightJob: toJobSummary(inFlight),
        },
        { status: 429 },
      );
    }

    const body = await readBody(request);
    const { softCap, hardCap } = getConfiguredThresholds();

    const gmail = await getGmailClientForEmail({
      emailAccountId,
      logger: request.logger,
    });

    const preview = await previewApplierBlastRadius({
      senderEmail: canonical,
      action: decision.action,
      hardCap,
      logger: request.logger,
      deps: { gmail },
    });

    // `preview: true` short-circuit for the UI modal.
    if (body.preview === true) {
      return NextResponse.json<ApplyRetroPreviewResponse>({
        count: preview.count,
        overHardCap: preview.overHardCap,
        softCap,
        hardCap,
      });
    }

    const decisionResult = evaluateApplyRetroGuard({
      preview,
      softCap,
      hardCap,
      body,
    });

    if (!decisionResult.ok) {
      request.logger.warn("apply_retro.guard_rejected", {
        emailAccountId,
        senderEmail: canonical,
        action: decision.action,
        previewCount: preview.count,
        overHardCap: preview.overHardCap,
        code: decisionResult.code,
        module: MODULE,
      });
      return NextResponse.json(
        {
          error: decisionResult.message,
          code: decisionResult.code,
          previewCount: preview.count,
          overHardCap: preview.overHardCap,
          softCap,
          hardCap,
          requiredConfirmation: true,
        },
        { status: decisionResult.status },
      );
    }

    if (decisionResult.requiresOverrideLog) {
      request.logger.warn("apply_retro.hard_cap_override", {
        emailAccountId,
        operator: request.auth.email,
        senderEmail: canonical,
        action: decision.action,
        previewCount: preview.count,
        overHardCap: preview.overHardCap,
        hardCap,
        module: MODULE,
      });
    }

    request.logger.info("apply_retro.started", {
      emailAccountId,
      operator: request.auth.email,
      senderEmail: canonical,
      action: decision.action,
      previewCount: preview.count,
      overHardCap: preview.overHardCap,
      confirm: body.confirm === true,
      override: body.override === true,
      softCap,
      hardCap,
      module: MODULE,
    });

    const job = await prisma.senderDecisionJob.create({
      data: {
        emailAccountId,
        senderEmail: canonical,
        action: decision.action,
        status: "pending",
        total: preview.overHardCap ? 0 : preview.count,
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
