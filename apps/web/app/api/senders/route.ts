import { NextResponse } from "next/server";
import { z } from "zod";
import chunk from "lodash/chunk";
import type { SenderAction } from "@/generated/prisma/enums";
import { withEmailProvider, withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getMessages } from "@/utils/gmail/message";
import { getGmailClientForEmail } from "@/utils/email-account-client";
import { GmailLabel } from "@/utils/gmail/label";
import { runGmailOp } from "@/utils/gmail/errors";
import { buildArchiveQuery } from "@/app/api/historical-senders/scan-runner";
import { getKillSwitchStatus } from "@/utils/kill-switch";
import {
  changeSenderDecision,
  deleteSenderDecision,
} from "@/utils/sender-decision/change";
import { canonicalizeSender } from "@/utils/sender-decision";
import { createScopedLogger } from "@/utils/logger";

// ---------------------------------------------------------------------------
// Per-sender 4-actions API (EL-442) — single Senders list page with four
// per-row actions (spec: memory/projects/inbox-zero-four-actions-spec.md).
//
// Persistence layer: reads/writes the fork's `SenderDecision` Prisma model so
// the EL-356 new-mail gate honours the user's choice automatically. The legacy
// sidecar tables (`sender_truth`, `vip_senders`, `blocked_senders`) are NOT
// written from this route — those are sidecar pipeline concerns.
//
// UI ↔ DB action mapping:
//   archive_forever → SenderAction.auto_archive  (removeLabelIds:[INBOX])
//   delete          → SenderAction.auto_trash    (addLabelIds:[TRASH])
//   custom_rule     → SenderAction.review        (placeholder until EL-439)
//   none            → row deleted                (deleteSenderDecision)
//
// Gmail vocabulary (DO NOT confuse):
//   archive          = removeLabelIds:[INBOX]      — keep emails, just out of inbox
//   delete (trash)   = addLabelIds:[TRASH]         — 30-day recovery
//   permanent_delete = NOT IMPLEMENTED in Phase 1  — gone forever
// ---------------------------------------------------------------------------

const log = createScopedLogger("senders-actions");

export type SenderRowAction =
  | "none"
  | "archive_forever"
  | "delete"
  | "custom_rule";

export type SenderRow = {
  senderEmail: string;
  senderDomain: string;
  receivedCount: number;
  sentToThemCount: number;
  lastReceived: string | null;
  lastSentToThem: string | null;
  category: string | null;
  // Current durable action state for this sender:
  currentAction: SenderRowAction;
  // Provenance flags:
  isVip: boolean;
  isBlocked: boolean;
  hasCustomRule: boolean;
};

export type SendersListResponse = {
  senders: SenderRow[];
  total: number;
  killSwitchPaused: boolean;
};

type RawRow = {
  sender_email: string;
  sender_domain: string;
  total_received_from: number | null;
  total_sent_to_them: number | null;
  last_received: string | null;
  last_replied: string | null;
  category: string | null;
  is_vip: boolean;
  is_blocked: boolean;
};

// SenderAction → SenderRowAction (DB → UI)
function dbActionToUi(
  action: SenderAction | null | undefined,
): SenderRowAction {
  switch (action) {
    case "auto_archive":
      return "archive_forever";
    case "auto_trash":
      return "delete";
    case "review":
      // We use 'review' as the placeholder for custom_rule. If the row exists
      // and is in 'review' state with our specific source tag we treat it as
      // custom_rule; otherwise it's effectively no-action from a UI standpoint.
      return "custom_rule";
    default:
      return "none";
  }
}

// SenderRowAction → SenderAction (UI → DB)
function uiActionToDb(action: SenderRowAction): SenderAction | null {
  switch (action) {
    case "archive_forever":
      return "auto_archive";
    case "delete":
      return "auto_trash";
    case "custom_rule":
      return "review";
    case "none":
      return null;
  }
}

// ---------------------------------------------------------------------------
// GET — paged senders list
// ---------------------------------------------------------------------------

export const GET = withEmailAccount("senders/list", async (request, _ctx) => {
  const { emailAccountId } = request.auth;

  const url = new URL(request.url);
  const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
  const limit = Math.min(
    Math.max(
      Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200,
      1,
    ),
    1000,
  );
  const offset = Math.max(
    Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
    0,
  );
  const filter = url.searchParams.get("filter") ?? "all"; // all|archive_forever|delete|custom_rule|none|vip|blocked

  const searchClause = search ? `%${search}%` : null;

  // Read sender list + volume + provenance from the sidecar tables (read-only
  // on this side). These are shared-DB tables so direct SQL is fine — the
  // ownership of write paths remains with the sidecar admin endpoints.
  const rows = await prisma.$queryRawUnsafe<RawRow[]>(
    `
      WITH all_addrs AS (
        SELECT sender_email AS addr FROM sender_truth
        UNION
        SELECT address       AS addr FROM sender_aggregates
        UNION
        SELECT address       AS addr FROM vip_senders     WHERE address IS NOT NULL
        UNION
        SELECT address       AS addr FROM blocked_senders WHERE address IS NOT NULL
      )
      SELECT
        a.addr                                                AS sender_email,
        COALESCE(SPLIT_PART(a.addr, '@', 2), '')              AS sender_domain,
        sa.total_received_from                                AS total_received_from,
        sa.total_sent_to_them                                 AS total_sent_to_them,
        to_char(sa.last_received, 'YYYY-MM-DD')               AS last_received,
        to_char(sa.last_replied,  'YYYY-MM-DD')               AS last_replied,
        st.category                                           AS category,
        (vs.id IS NOT NULL)                                   AS is_vip,
        (bs.id IS NOT NULL)                                   AS is_blocked
      FROM all_addrs a
      LEFT JOIN sender_truth        st ON st.sender_email = a.addr
      LEFT JOIN sender_aggregates   sa ON sa.address      = a.addr
      LEFT JOIN vip_senders         vs ON vs.address      = a.addr
      LEFT JOIN blocked_senders     bs ON bs.address      = a.addr
      WHERE ($1::text IS NULL OR a.addr ILIKE $1)
      ORDER BY COALESCE(sa.total_received_from, 0) DESC, a.addr ASC
      LIMIT $2 OFFSET $3
      `,
    searchClause,
    limit,
    offset,
  );

  // Action state lives in SenderDecision (the EL-356 gate's source of truth).
  const senderEmails = rows.map((r) => r.sender_email);
  const decisions =
    senderEmails.length > 0
      ? await prisma.senderDecision.findMany({
          where: {
            emailAccountId,
            senderEmail: { in: senderEmails },
          },
          select: { senderEmail: true, action: true },
        })
      : [];
  const actionByEmail = new Map<string, SenderAction>(
    decisions.map((d) => [d.senderEmail, d.action]),
  );

  const senders: SenderRow[] = rows.map((r) => {
    const receivedCount = Number(r.total_received_from ?? 0);
    const sentToThemCount = Number(r.total_sent_to_them ?? 0);
    const dbAction = actionByEmail.get(r.sender_email) ?? null;
    return {
      senderEmail: r.sender_email,
      senderDomain: r.sender_domain,
      receivedCount,
      sentToThemCount,
      lastReceived: r.last_received,
      lastSentToThem: r.last_replied,
      category: r.category,
      currentAction: dbActionToUi(dbAction),
      isVip: r.is_vip,
      isBlocked: r.is_blocked,
      hasCustomRule: dbAction === "review",
    };
  });

  const filtered =
    filter === "all"
      ? senders
      : filter === "vip"
        ? senders.filter((s) => s.isVip)
        : filter === "blocked"
          ? senders.filter((s) => s.isBlocked)
          : senders.filter((s) => s.currentAction === filter);

  const killSwitch = await getKillSwitchStatus(emailAccountId).catch(() => ({
    paused: false,
  }));

  const response: SendersListResponse = {
    senders: filtered,
    total: filtered.length,
    killSwitchPaused: killSwitch.paused,
  };
  return NextResponse.json(response);
});

// ---------------------------------------------------------------------------
// POST — apply a per-sender action (archive_forever | delete | none | custom_rule)
// ---------------------------------------------------------------------------

const actionSchema = z.object({
  senderEmail: z.string().min(1),
  action: z.enum(["none", "archive_forever", "delete", "custom_rule"]),
  // For 'delete' / 'archive_forever' we apply retroactively by default. Set
  // retroactive=false to skip (state-only write).
  retroactive: z.boolean().optional().default(true),
});

export type SenderActionRequest = z.infer<typeof actionSchema>;
export type SenderActionResponse = {
  ok: boolean;
  senderEmail: string;
  action: SenderRowAction;
  retroactiveApplied: number;
  killSwitchPaused?: boolean;
  message?: string;
};

const BATCH_MODIFY_CHUNK_SIZE = 1000;

export const POST = withEmailProvider("senders/action", async (request) => {
  const { emailAccountId } = request.auth;
  const { emailProvider, logger } = request;

  if (!isGoogleProvider(emailProvider.name)) {
    return NextResponse.json(
      { error: "Only Gmail is supported.", isKnownError: true },
      { status: 400 },
    );
  }

  const body = actionSchema.parse(await request.json());
  const senderEmail = canonicalizeSender(body.senderEmail);
  if (!senderEmail) {
    return NextResponse.json(
      { error: "Invalid sender email", isKnownError: true },
      { status: 400 },
    );
  }

  // Kill switch — never bypass.
  const killSwitch = await getKillSwitchStatus(emailAccountId).catch(() => ({
    paused: false,
  }));
  if (killSwitch.paused && body.action !== "none") {
    return NextResponse.json<SenderActionResponse>({
      ok: false,
      senderEmail,
      action: body.action,
      retroactiveApplied: 0,
      killSwitchPaused: true,
      message: "Autonomous actions are paused. Resume the kill switch to act.",
    });
  }

  // ── 1. Persist durable per-sender state via SenderDecision ──────────────
  // changeSenderDecision/deleteSenderDecision write the audited helper path
  // (EL-365) so every change emits a structured log + history row.
  const dbAction = uiActionToDb(body.action);
  if (dbAction === null) {
    // 'none' → drop the row.
    await deleteSenderDecision({
      emailAccountId,
      senderEmail,
      actor: "user",
      decisionSource: "user",
      auditSource: "ui:senders-page",
      reason: "Cleared via /senders page",
      allowOverwriteUser: true,
    }).catch((err) => {
      // If the row didn't exist, deleteSenderDecision still creates a
      // 'review' row via the upsert path — that's fine; we silently
      // continue. Real errors are re-thrown.
      if (err instanceof Error && /not found/i.test(err.message)) return;
      throw err;
    });
  } else {
    await changeSenderDecision({
      emailAccountId,
      senderEmail,
      action: dbAction,
      actor: "user",
      decisionSource: "user",
      auditSource: "ui:senders-page",
      reason: `Set via /senders page: ${body.action}`,
      allowOverwriteUser: true,
      autoAppliedAt: null,
    });
  }

  // ── 2. Apply retroactive Gmail action (best-effort, idempotent) ─────────
  let retroactiveApplied = 0;
  if (
    body.retroactive &&
    (body.action === "archive_forever" || body.action === "delete")
  ) {
    const gmail = await getGmailClientForEmail({ emailAccountId, logger });
    const query = buildArchiveQuery(senderEmail);
    let pageToken: string | undefined;

    do {
      const { messages, nextPageToken } = await getMessages(gmail, {
        query,
        maxResults: 500,
        pageToken,
      });
      if (body.action === "archive_forever") {
        // Archive: removing INBOX label is exactly what 'archived' means in
        // Gmail — batchModify is fine here.
        const ids = messages.map((m) => m.id).filter(Boolean) as string[];
        if (ids.length > 0) {
          for (const slice of chunk(ids, BATCH_MODIFY_CHUNK_SIZE)) {
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
                op: "batch_archive",
                targetId: `sender:${senderEmail}:${slice.length}`,
                downgradeNotFound: true,
              },
            );
            retroactiveApplied += slice.length;
          }
        }
      } else {
        // EL-459: Trash via users.messages.trash (the proper Gmail
        // 'move to Trash' API). batchModify+addLabelIds:[TRASH] is
        // unreliable — Gmail accepts the label add but doesn't always
        // actually move the message to Trash. messages.trash guarantees the
        // message shows up in the user's Trash folder. NEVER messages.delete.
        for (const msg of messages) {
          if (!msg.id) continue;
          await runGmailOp(
            () =>
              gmail.users.messages.trash({
                userId: "me",
                id: msg.id!,
              }),
            {
              op: "trash_message",
              targetId: `sender:${senderEmail}:msg:${msg.id}`,
              downgradeNotFound: true,
            },
          );
          retroactiveApplied += 1;
        }
      }
      pageToken = nextPageToken ?? undefined;
    } while (pageToken);

    log.info("retroactive applied", {
      senderEmail,
      action: body.action,
      retroactiveApplied,
      emailAccountId,
    });
  }

  return NextResponse.json<SenderActionResponse>({
    ok: true,
    senderEmail,
    action: body.action,
    retroactiveApplied,
  });
});
