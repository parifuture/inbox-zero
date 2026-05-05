import type { Prisma, SenderDecision } from "@/generated/prisma/client";
import type { SenderAction } from "@/generated/prisma/enums";
import { extractDomainFromEmail, extractEmailAddress } from "@/utils/email";
import prisma from "@/utils/prisma";
/**
 * Canonicalize a raw "From" header or bare email into a stable key suitable
 * for use as `SenderDecision.senderEmail`.
 *
 * Handles:
 *  - Display names: `"Name" <a@b.com>` -> `a@b.com`
 *  - Gmail +tag addressing: `a+anything@b.com` -> `a@b.com`
 *  - Mixed case domains / addresses: lowercases the whole thing.
 *  - Whitespace and quoting.
 *
 * Returns `""` when the input does not contain a recognizable email address.
 */
export function canonicalizeSender(rawAddress: string): string {
  if (!rawAddress) return "";

  const extracted = rawAddress.includes("<")
    ? extractEmailAddress(rawAddress)
    : rawAddress.trim();
  if (!extracted) return "";

  const lowered = extracted.toLowerCase();
  const atIdx = lowered.indexOf("@");
  if (atIdx < 1 || atIdx === lowered.length - 1) return "";

  const localPart = lowered.slice(0, atIdx);
  const domain = lowered.slice(atIdx + 1);

  // Strip +tag addressing (Gmail and many providers).
  const plusIdx = localPart.indexOf("+");
  const cleanLocal = plusIdx === -1 ? localPart : localPart.slice(0, plusIdx);
  if (!cleanLocal) return "";

  return `${cleanLocal}@${domain}`;
}

export function canonicalizeSenderOrThrow(rawAddress: string): string {
  const canon = canonicalizeSender(rawAddress);
  if (!canon) throw new Error(`Invalid sender address: ${rawAddress}`);
  return canon;
}

export async function getDecision(
  emailAccountId: string,
  rawSender: string,
): Promise<SenderDecision | null> {
  const senderEmail = canonicalizeSender(rawSender);
  if (!senderEmail) return null;
  return prisma.senderDecision.findUnique({
    where: {
      emailAccountId_senderEmail: { emailAccountId, senderEmail },
    },
  });
}

export type UpsertDecisionInput = {
  emailAccountId: string;
  senderEmail: string; // raw or canonicalized; will be canonicalized here
  action: SenderAction;
  source: string; // "user" | "seed" | "llm_suggestion" | "rule"
  note?: string | null;
  firstSeenAt?: Date | null;
  lastSeenAt?: Date | null;
  messageCount?: number;
  autoAppliedAt?: Date | null;
  keepLabelId?: string | null;
  keepLabelName?: string | null;
  /**
   * When true (default), existing rows whose `source === "user"` are NOT
   * overwritten by non-user upserts. User decisions are sticky.
   */
  protectUserDecisions?: boolean;
};

/**
 * Idempotent upsert. Respects user-authored decisions by default: a non-user
 * source will only update volume metadata (counts, seen dates) and leave the
 * user's chosen action/note intact.
 */
export async function upsertDecision(
  input: UpsertDecisionInput,
): Promise<SenderDecision> {
  const {
    emailAccountId,
    action,
    source,
    note = null,
    firstSeenAt = null,
    lastSeenAt = null,
    messageCount,
    autoAppliedAt = null,
    keepLabelId,
    keepLabelName,
    protectUserDecisions = true,
  } = input;

  const senderEmail = canonicalizeSenderOrThrow(input.senderEmail);
  const senderDomain = extractDomainFromEmail(senderEmail).toLowerCase();

  const existing = await prisma.senderDecision.findUnique({
    where: {
      emailAccountId_senderEmail: { emailAccountId, senderEmail },
    },
    select: { id: true, source: true },
  });

  const isProtectedUserRow =
    existing?.source === "user" && protectUserDecisions && source !== "user";

  const updateData: Prisma.SenderDecisionUpdateInput = isProtectedUserRow
    ? {
        // Don't touch action/source/note — only refresh volume telemetry.
        senderDomain,
        firstSeenAt: firstSeenAt ?? undefined,
        lastSeenAt: lastSeenAt ?? undefined,
        messageCount:
          typeof messageCount === "number" ? messageCount : undefined,
        autoAppliedAt: autoAppliedAt ?? undefined,
        keepLabelId: keepLabelId === undefined ? undefined : keepLabelId,
        keepLabelName: keepLabelName === undefined ? undefined : keepLabelName,
      }
    : {
        senderDomain,
        action,
        source,
        note,
        firstSeenAt: firstSeenAt ?? undefined,
        lastSeenAt: lastSeenAt ?? undefined,
        messageCount:
          typeof messageCount === "number" ? messageCount : undefined,
        autoAppliedAt: autoAppliedAt ?? undefined,
        keepLabelId: keepLabelId === undefined ? undefined : keepLabelId,
        keepLabelName: keepLabelName === undefined ? undefined : keepLabelName,
      };

  return prisma.senderDecision.upsert({
    where: {
      emailAccountId_senderEmail: { emailAccountId, senderEmail },
    },
    create: {
      emailAccountId,
      senderEmail,
      senderDomain,
      action,
      source,
      note,
      firstSeenAt,
      lastSeenAt,
      messageCount: messageCount ?? 0,
      autoAppliedAt,
      keepLabelId: keepLabelId ?? null,
      keepLabelName: keepLabelName ?? null,
    },
    update: updateData,
  });
}

export type ListByActionOptions = {
  emailAccountId: string;
  take?: number;
  skip?: number;
  domain?: string;
  search?: string; // substring match on senderEmail
};

export async function listByAction(
  action: SenderAction,
  opts: ListByActionOptions,
): Promise<SenderDecision[]> {
  const { emailAccountId, take = 100, skip = 0, domain, search } = opts;
  return prisma.senderDecision.findMany({
    where: {
      emailAccountId,
      action,
      ...(domain ? { senderDomain: domain.toLowerCase() } : {}),
      ...(search ? { senderEmail: { contains: search.toLowerCase() } } : {}),
    },
    orderBy: [{ messageCount: "desc" }, { lastSeenAt: "desc" }],
    take,
    skip,
  });
}
