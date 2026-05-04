import prisma from "@/utils/prisma";
import { createScopedLogger, type Logger } from "@/utils/logger";

const MODULE = "kill-switch";

/**
 * Short-lived in-memory cache so hot paths (rule evaluation on every incoming
 * message) don't hit Postgres on every call. The ticket (EL-370) requires
 * pause propagation in \u2264 5s; the TTL is well under that budget.
 *
 * The cache is bust explicitly whenever `setAutonomousPaused` toggles the
 * flag, so in a single-process fork the effective propagation is immediate.
 */
const CACHE_TTL_MS = 2000;

type CacheEntry = {
  paused: boolean;
  pausedAt: Date | null;
  pausedBy: string | null;
  pauseReason: string | null;
  fetchedAt: number;
};

const cache = new Map<string, CacheEntry>();

export function invalidateKillSwitchCache(emailAccountId?: string): void {
  if (emailAccountId) cache.delete(emailAccountId);
  else cache.clear();
}

async function loadStatus(emailAccountId: string): Promise<CacheEntry> {
  const row = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      autonomousActionsPaused: true,
      autonomousActionsPausedAt: true,
      autonomousActionsPausedBy: true,
      autonomousActionsPauseReason: true,
    },
  });

  const entry: CacheEntry = {
    paused: Boolean(row?.autonomousActionsPaused),
    pausedAt: row?.autonomousActionsPausedAt ?? null,
    pausedBy: row?.autonomousActionsPausedBy ?? null,
    pauseReason: row?.autonomousActionsPauseReason ?? null,
    fetchedAt: Date.now(),
  };
  cache.set(emailAccountId, entry);
  return entry;
}

export type KillSwitchStatus = {
  paused: boolean;
  pausedAt: Date | null;
  pausedBy: string | null;
  pauseReason: string | null;
};

export async function getKillSwitchStatus(
  emailAccountId: string,
  options?: { skipCache?: boolean },
): Promise<KillSwitchStatus> {
  if (!options?.skipCache) {
    const cached = cache.get(emailAccountId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return {
        paused: cached.paused,
        pausedAt: cached.pausedAt,
        pausedBy: cached.pausedBy,
        pauseReason: cached.pauseReason,
      };
    }
  }
  const fresh = await loadStatus(emailAccountId);
  return {
    paused: fresh.paused,
    pausedAt: fresh.pausedAt,
    pausedBy: fresh.pausedBy,
    pauseReason: fresh.pauseReason,
  };
}

export async function isAutonomousPaused(
  emailAccountId: string,
): Promise<boolean> {
  const status = await getKillSwitchStatus(emailAccountId);
  return status.paused;
}

export async function setAutonomousPaused(params: {
  emailAccountId: string;
  paused: boolean;
  actor: string;
  reason?: string | null;
  logger?: Logger;
}): Promise<KillSwitchStatus> {
  const {
    emailAccountId,
    paused,
    actor,
    reason = null,
    logger = createScopedLogger("kill-switch"),
  } = params;

  const now = new Date();
  const updated = await prisma.emailAccount.update({
    where: { id: emailAccountId },
    data: paused
      ? {
          autonomousActionsPaused: true,
          autonomousActionsPausedAt: now,
          autonomousActionsPausedBy: actor,
          autonomousActionsPauseReason: reason,
        }
      : {
          autonomousActionsPaused: false,
          autonomousActionsPausedAt: null,
          autonomousActionsPausedBy: null,
          autonomousActionsPauseReason: null,
        },
    select: {
      autonomousActionsPaused: true,
      autonomousActionsPausedAt: true,
      autonomousActionsPausedBy: true,
      autonomousActionsPauseReason: true,
    },
  });

  invalidateKillSwitchCache(emailAccountId);

  logger.warn("kill_switch.toggled", {
    emailAccountId,
    paused,
    actor,
    reason,
    module: MODULE,
  });

  return {
    paused: updated.autonomousActionsPaused,
    pausedAt: updated.autonomousActionsPausedAt,
    pausedBy: updated.autonomousActionsPausedBy,
    pauseReason: updated.autonomousActionsPauseReason,
  };
}

/** Exported for tests only. */
export const __internals = { cache, CACHE_TTL_MS };
