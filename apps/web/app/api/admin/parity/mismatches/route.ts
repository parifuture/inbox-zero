/**
 * EL-376 — admin parity mismatches endpoint.
 *
 * GET /api/admin/parity/mismatches
 *   ?days=30
 *   &limit=100
 *   &offset=0
 *   &mismatchType=fork_trash_sidecar_keep
 *   &search=sender@example.com
 *   &emailAccountId=...
 *
 * Returns the most recent `ParityDecision` rows where `action !==
 * sidecarAction` (and both are set). Also surfaces enough metadata for the
 * EL-376 dashboard to render the "Prefer fork / Prefer sidecar" buttons:
 *   - row id
 *   - emailAccountId (the override must be scoped per-account)
 *   - senderEmail / subject / messageId / threadId
 *   - forkAction / forkRuleName
 *   - sidecarAction / sidecarRuleName
 *   - createdAt
 *
 * Safety: read-only. Gated behind the admin middleware.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { withAdmin } from "@/utils/middleware";
import prisma from "@/utils/prisma";

const TRASHY = new Set(["trash"]);
const KEEPY = new Set(["inbox", "review", "noMatch"]);

const MISMATCH_TYPES = [
  "any",
  "fork_trash_sidecar_keep",
  "fork_keep_sidecar_trash",
  "fork_review_sidecar_trash",
  "fork_trash_sidecar_review",
  "other",
] as const;

export type ParityMismatchRow = {
  id: string;
  emailAccountId: string;
  createdAt: string;
  messageId: string;
  threadId: string | null;
  senderEmail: string;
  subject: string | null;
  forkAction: string;
  forkRuleName: string | null;
  forkReason: string | null;
  forkStage: number;
  sidecarAction: string;
  sidecarRuleName: string | null;
};

export type GetAdminParityMismatchesResponse = {
  items: ParityMismatchRow[];
  total: number;
};

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  mismatchType: z.enum(MISMATCH_TYPES).default("any"),
  search: z.string().trim().min(1).max(200).optional(),
  emailAccountId: z.string().optional(),
});

function mismatchMatches(
  type: (typeof MISMATCH_TYPES)[number],
  fork: string,
  sidecar: string,
): boolean {
  switch (type) {
    case "any":
      return true;
    case "fork_trash_sidecar_keep":
      return TRASHY.has(fork) && KEEPY.has(sidecar);
    case "fork_keep_sidecar_trash":
      return KEEPY.has(fork) && TRASHY.has(sidecar);
    case "fork_review_sidecar_trash":
      return fork === "review" && sidecar === "trash";
    case "fork_trash_sidecar_review":
      return fork === "trash" && sidecar === "review";
    case "other":
      return (
        !(TRASHY.has(fork) && KEEPY.has(sidecar)) &&
        !(KEEPY.has(fork) && TRASHY.has(sidecar)) &&
        !(fork === "review" && sidecar === "trash") &&
        !(fork === "trash" && sidecar === "review")
      );
  }
}

export const GET = withAdmin(
  "admin/parity/mismatches",
  async (request: Request) => {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { days, limit, offset, mismatchType, search, emailAccountId } =
      parsed.data;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // We filter "action !== sidecarAction" in-memory because Prisma's JSON
    // filter syntax doesn't support cross-column comparison cleanly across
    // providers. The row volume is bounded by `limit * 5` to keep this cheap
    // while still giving us enough rows to satisfy the filter.
    const prefetch = Math.min(5000, (offset + limit) * 5);

    const where = {
      createdAt: { gte: since },
      sidecarAction: { not: null },
      ...(emailAccountId ? { emailAccountId } : {}),
      ...(search
        ? {
            senderEmail: {
              contains: search.toLowerCase(),
            },
          }
        : {}),
    };

    const rows = await prisma.parityDecision.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: prefetch,
    });

    const filtered = rows.filter(
      (r) =>
        r.sidecarAction != null &&
        r.action !== r.sidecarAction &&
        mismatchMatches(mismatchType, r.action, r.sidecarAction),
    );

    const page = filtered.slice(offset, offset + limit).map(
      (r): ParityMismatchRow => ({
        id: r.id,
        emailAccountId: r.emailAccountId,
        createdAt: r.createdAt.toISOString(),
        messageId: r.messageId,
        threadId: r.threadId,
        senderEmail: r.senderEmail,
        subject: r.subject,
        forkAction: r.action,
        forkRuleName: r.ruleName,
        forkReason: r.reasoning,
        forkStage: r.stage,
        sidecarAction: r.sidecarAction as string,
        sidecarRuleName: r.sidecarRuleName,
      }),
    );

    return NextResponse.json({
      items: page,
      total: filtered.length,
    } satisfies GetAdminParityMismatchesResponse);
  },
);
