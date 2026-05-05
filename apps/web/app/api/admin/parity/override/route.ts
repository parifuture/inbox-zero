/**
 * EL-376 — admin parity override.
 *
 * POST /api/admin/parity/override
 *   body: {
 *     parityDecisionId: string,
 *     preference: "fork" | "sidecar",
 *   }
 *
 * Resolves the parity row, picks the chosen side's action, maps it to a
 * `SenderAction`, and writes a `SenderDecision` override for that account +
 * sender. Audit note references the parity decision id so the diff is
 * traceable end-to-end. Admin-gated.
 *
 * Safety:
 *   - Trash-only / keep-only / review are allowed. No permanent delete path.
 *   - Uses `upsertDecision(source="user", protectUserDecisions=false)` —
 *     same semantics as the EL-355 POST /api/sender-decisions endpoint.
 *   - Fails closed for unknown / unmappable actions.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAdmin } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { canonicalizeSender, upsertDecision } from "@/utils/sender-decision";
import { logDecisionAudit } from "@/utils/sender-decision/audit";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("admin/parity/override");

const bodySchema = z.object({
  parityDecisionId: z.string().min(1),
  preference: z.enum(["fork", "sidecar"]),
});

export type PostAdminParityOverrideResponse = {
  ok: true;
  senderEmail: string;
  action: "auto_trash" | "always_keep" | "review";
  parityDecisionId: string;
};

/** Map a fork/sidecar action string to a `SenderDecision.action`. */
function mapAction(
  raw: string | null | undefined,
): "auto_trash" | "always_keep" | "review" | null {
  switch (raw) {
    case "trash":
      return "auto_trash";
    case "inbox":
      return "always_keep";
    case "review":
      return "review";
    // `noMatch` means the fork had nothing to say — not a usable override.
    default:
      return null;
  }
}

export const POST = withAdmin("admin/parity/override", async (request) => {
  const raw = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { parityDecisionId, preference } = parsed.data;

  const row = await prisma.parityDecision.findUnique({
    where: { id: parityDecisionId },
  });
  if (!row) {
    return NextResponse.json(
      { error: "Parity decision not found" },
      { status: 404 },
    );
  }

  const chosenRaw = preference === "fork" ? row.action : row.sidecarAction;
  const mapped = mapAction(chosenRaw);
  if (!mapped) {
    return NextResponse.json(
      {
        error: `Cannot map ${preference} action "${chosenRaw}" to a SenderDecision action`,
      },
      { status: 400 },
    );
  }

  const canonical = canonicalizeSender(row.senderEmail);
  if (!canonical) {
    return NextResponse.json(
      { error: "Parity row has unparseable senderEmail" },
      { status: 422 },
    );
  }

  const before = await prisma.senderDecision.findUnique({
    where: {
      emailAccountId_senderEmail: {
        emailAccountId: row.emailAccountId,
        senderEmail: canonical,
      },
    },
  });

  const note = `parity:${preference}:${parityDecisionId}`;

  const after = await upsertDecision({
    emailAccountId: row.emailAccountId,
    senderEmail: canonical,
    action: mapped,
    source: "user",
    note,
    protectUserDecisions: false,
  });

  await logDecisionAudit({
    emailAccountId: row.emailAccountId,
    senderEmail: canonical,
    before,
    after,
    actor: "user",
    action: before ? "update" : "create",
  });

  logger.info("parity override applied", {
    email_account_id: row.emailAccountId,
    sender_email: canonical,
    preference,
    chosen_action: mapped,
    parity_decision_id: parityDecisionId,
  });

  return NextResponse.json({
    ok: true,
    senderEmail: canonical,
    action: mapped,
    parityDecisionId,
  } satisfies PostAdminParityOverrideResponse);
});
