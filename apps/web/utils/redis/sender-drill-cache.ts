import { redis } from "@/utils/redis";
import { createScopedLogger } from "@/utils/logger";

/**
 * Redis cache for SenderDetail drill-in (EL-362).
 *
 * One cache entry per (emailAccountId, senderEmail, pageCursor) so "load
 * more" pages don't invalidate the first page, and vice-versa. Refresh
 * invalidates every cursor for a given sender.
 *
 * TTL strategy:
 *  - Successful fetch        → 24h
 *  - Partial (Gmail 429)     → 5m so we retry soon
 */

const logger = createScopedLogger("sender-drill-cache");

export const SENDER_DRILL_SUCCESS_TTL_SEC = 24 * 60 * 60;
export const SENDER_DRILL_PARTIAL_TTL_SEC = 5 * 60;

/** Shape persisted in Redis. Keep small — bodies are out of scope. */
export type SenderDrillLabelState = "inbox" | "archived" | "trashed" | "sent";

export interface SenderDrillMessage {
  date: string | null;
  id: string;
  labelState: SenderDrillLabelState;
  snippet: string;
  subject: string;
  threadId: string;
}

export interface SenderDrillCachePayload {
  fetchedAt: string; // ISO-8601
  messages: SenderDrillMessage[];
  nextPageToken: string | null;
  partial: boolean;
}

function cursorSegment(cursor: string | null | undefined): string {
  return cursor && cursor.length > 0 ? cursor : "_";
}

export function senderDrillCacheKey(params: {
  emailAccountId: string;
  senderEmail: string;
  cursor: string | null | undefined;
}): string {
  const { emailAccountId, senderEmail, cursor } = params;
  // Lower-cased sender for cache cohesion — writers canonicalize before
  // hitting the cache too (see /api route).
  return `sender-drill:${emailAccountId}:${senderEmail.toLowerCase()}:${cursorSegment(cursor)}`;
}

export function senderDrillInvalidationPattern(params: {
  emailAccountId: string;
  senderEmail: string;
}): string {
  return `sender-drill:${params.emailAccountId}:${params.senderEmail.toLowerCase()}:*`;
}

export async function getCachedSenderDrill(params: {
  emailAccountId: string;
  senderEmail: string;
  cursor: string | null | undefined;
}): Promise<SenderDrillCachePayload | null> {
  const key = senderDrillCacheKey(params);
  try {
    const raw = await redis.get<SenderDrillCachePayload>(key);
    if (!raw) return null;
    // Upstash SDK auto-deserializes JSON for typed calls; guard against
    // malformed entries anyway.
    if (!raw.messages || !Array.isArray(raw.messages)) return null;
    return raw;
  } catch (err) {
    logger.warn("drill_in.cache_read_failed", { err, key });
    return null;
  }
}

export async function setCachedSenderDrill(
  params: {
    emailAccountId: string;
    senderEmail: string;
    cursor: string | null | undefined;
  },
  payload: SenderDrillCachePayload,
): Promise<void> {
  const key = senderDrillCacheKey(params);
  const ttl = payload.partial
    ? SENDER_DRILL_PARTIAL_TTL_SEC
    : SENDER_DRILL_SUCCESS_TTL_SEC;
  try {
    await redis.set(key, payload, { ex: ttl });
  } catch (err) {
    logger.warn("drill_in.cache_write_failed", { err, key });
  }
}

/**
 * Invalidate every cached page for a given (account, sender). Used when
 * the client hits the Refresh button with `bypassCache=1`.
 *
 * Upstash doesn't support server-side `KEYS` in all plans, so we scan
 * with a cursor loop. Safe for the tiny keyspace a single sender occupies.
 */
export async function invalidateSenderDrill(params: {
  emailAccountId: string;
  senderEmail: string;
}): Promise<number> {
  const pattern = senderDrillInvalidationPattern(params);
  let cursor = "0";
  let deleted = 0;
  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, {
        match: pattern,
        count: 100,
      });
      cursor = String(nextCursor);
      if (keys.length > 0) {
        deleted += (await redis.del(...keys)) ?? 0;
      }
    } while (cursor !== "0");
  } catch (err) {
    logger.warn("drill_in.cache_invalidate_failed", { err, pattern });
  }
  return deleted;
}

/**
 * Derive display label state from Gmail's message `labelIds`. Priority:
 * TRASH > SENT > INBOX > archived (everything else).
 */
export function deriveSenderDrillLabelState(
  labelIds: string[] | null | undefined,
): SenderDrillLabelState {
  if (!labelIds || labelIds.length === 0) return "archived";
  if (labelIds.includes("TRASH")) return "trashed";
  if (labelIds.includes("SENT")) return "sent";
  if (labelIds.includes("INBOX")) return "inbox";
  return "archived";
}
