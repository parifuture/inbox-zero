import { NextResponse } from "next/server";
import chunk from "lodash/chunk";
import { withEmailProvider } from "@/utils/middleware";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getGmailClientForEmail } from "@/utils/email-account-client";
import { getMessages } from "@/utils/gmail/message";
import { GmailLabel } from "@/utils/gmail/label";
import { runGmailOp } from "@/utils/gmail/errors";
import { buildArchiveQuery } from "@/app/api/historical-senders/scan-runner";
import { getKillSwitchStatus } from "@/utils/kill-switch";
import prisma from "@/utils/prisma";
import { ActionType } from "@/generated/prisma/enums";

// EL-454 — Apply a sender-locked Rule to historical mail from its scoping
// sender. Opt-in path triggered from the EL-451 preview card "Apply to
// historical mail" toggle when the user clicks Save & activate.
//
// Safety posture:
//   - **Sender-lock required**: the Rule must have `lockedToSenderId` set
//     (created via the EL-450 per-sender chat). Non-locked rules cannot use
//     this endpoint — different scoping flows have different safety stories.
//   - **Phase 1 vocab**: ARCHIVE => `removeLabelIds:[INBOX]`. We never call
//     `messages.delete`. The Rule's ActionType.ARCHIVE is the only action
//     applied retroactively in this MVP. Other actions (LABEL, MARK_READ,
//     DIGEST, etc.) are deliberately skipped because their semantics are
//     forward-looking by design.
//   - **Safety query**: reuses `buildArchiveQuery`, which excludes
//     `in:sent`, `in:trash`, and `is:starred`.
//   - **Kill switch**: respects EL-370. Returns `killSwitchPaused: true`
//     and applies nothing when paused.
//
// Spec reference: 2026-05-16 daily log, EL-439 spec Q5 — apply-retroactive
// is opt-in per rule, default OFF.

export type ApplyHistoricalRuleResponse = {
  applied: boolean;
  archived: number;
  trashed: number;
  reason?:
    | "unsupported_action"
    | "kill_switch_paused"
    | "not_sender_locked"
    | "rule_not_found";
  killSwitchPaused?: boolean;
};

const BATCH_MODIFY_CHUNK_SIZE = 1000;

export const POST = withEmailProvider(
  "rules/apply-historical",
  async (request, context) => {
    const { emailAccountId } = request.auth;
    const { emailProvider, logger } = request;

    if (!isGoogleProvider(emailProvider.name)) {
      return NextResponse.json(
        { error: "Only Gmail is supported.", isKnownError: true },
        { status: 400 },
      );
    }

    const params = await context.params;
    const ruleId = params.ruleId;
    if (!ruleId) {
      return NextResponse.json(
        { error: "Missing ruleId", isKnownError: true },
        { status: 400 },
      );
    }

    const rule = await prisma.rule.findUnique({
      where: { id: ruleId, emailAccountId },
      select: {
        id: true,
        from: true,
        lockedToSenderId: true,
        actions: { select: { type: true } },
      },
    });

    if (!rule) {
      return NextResponse.json<ApplyHistoricalRuleResponse>(
        {
          applied: false,
          archived: 0,
          trashed: 0,
          reason: "rule_not_found",
        },
        { status: 404 },
      );
    }

    // EL-451 invariant: only sender-locked rules can run retroactively from
    // this endpoint. The from-condition is the canonical scoping sender, so
    // we know exactly which sender's mail to touch and what the safety
    // boundary is.
    const senderEmail = rule.lockedToSenderId ?? null;
    if (!senderEmail) {
      return NextResponse.json<ApplyHistoricalRuleResponse>(
        {
          applied: false,
          archived: 0,
          trashed: 0,
          reason: "not_sender_locked",
        },
        { status: 400 },
      );
    }

    // EL-370 kill-switch — same posture as historical-senders/archive.
    const killSwitch = await getKillSwitchStatus(emailAccountId).catch(() => ({
      paused: false,
    }));
    if (killSwitch.paused) {
      return NextResponse.json<ApplyHistoricalRuleResponse>(
        {
          applied: false,
          archived: 0,
          trashed: 0,
          reason: "kill_switch_paused",
          killSwitchPaused: true,
        },
        { status: 200 },
      );
    }

    const hasArchiveAction = rule.actions.some(
      (a) => a.type === ActionType.ARCHIVE,
    );
    const hasTrashAction = rule.actions.some(
      (a) => a.type === ActionType.TRASH,
    );

    // EL-454/EL-457: TRASH takes precedence when both are set on the rule.
    // ARCHIVE-only and TRASH-only paths are both supported. Other action
    // types (LABEL/MARK_READ/DIGEST etc.) are forward-looking by design.
    if (!hasArchiveAction && !hasTrashAction) {
      return NextResponse.json<ApplyHistoricalRuleResponse>(
        {
          applied: false,
          archived: 0,
          trashed: 0,
          reason: "unsupported_action",
        },
        { status: 200 },
      );
    }

    const gmail = await getGmailClientForEmail({ emailAccountId, logger });

    const query = buildArchiveQuery(senderEmail);
    let archived = 0;
    let trashed = 0;
    let pageToken: string | undefined;

    do {
      const { messages, nextPageToken } = await getMessages(gmail, {
        query,
        maxResults: 500,
        pageToken,
      });

      if (hasTrashAction) {
        // EL-459: Use users.messages.trash (proper move-to-Trash API). The
        // batchModify+addLabelIds:[TRASH] approach is unreliable: Gmail
        // accepts the label add but doesn't always actually move the message
        // to Trash. messages.trash is the canonical 'show up in user's Trash
        // folder' API. NEVER call messages.delete (permanent).
        for (const msg of messages) {
          if (!msg.id) continue;
          await runGmailOp(
            () =>
              gmail.users.messages.trash({
                userId: "me",
                id: msg.id!,
              }),
            {
              op: "rule_apply_historical_trash",
              targetId: `rule:${ruleId}:sender:${senderEmail}:msg:${msg.id}`,
              downgradeNotFound: true,
            },
          );
          trashed += 1;
        }
      } else {
        const ids = messages.map((m) => m.id).filter(Boolean);
        if (ids.length > 0) {
          for (const slice of chunk(ids, BATCH_MODIFY_CHUNK_SIZE)) {
            // ARCHIVE path: removeLabelIds:[INBOX] only. batchModify is fine
            // for archive because we're only removing the INBOX label — the
            // 'archived' state in Gmail is just absence of INBOX, not a
            // dedicated folder API like Trash has.
            await runGmailOp(
              () =>
                gmail.users.messages.batchModify({
                  userId: "me",
                  requestBody: {
                    ids: slice,
                    removeLabelIds: [GmailLabel.INBOX],
                  },
                }),
              {
                op: "rule_apply_historical_archive",
                targetId: `rule:${ruleId}:sender:${senderEmail}:${slice.length}`,
                downgradeNotFound: true,
              },
            );
            archived += slice.length;
          }
        }
      }

      pageToken = nextPageToken;
    } while (pageToken);

    logger.info("Applied rule to historical mail", {
      ruleId,
      senderEmail,
      archived,
      trashed,
    });

    return NextResponse.json<ApplyHistoricalRuleResponse>({
      applied: true,
      archived,
      trashed,
    });
  },
);
