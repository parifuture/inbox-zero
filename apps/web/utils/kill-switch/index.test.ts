import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  __internals,
  getKillSwitchStatus,
  invalidateKillSwitchCache,
  isAutonomousPaused,
  setAutonomousPaused,
} from "./index";
import { createTestLogger } from "@/__tests__/helpers";

vi.mock("@/utils/prisma");

const logger = createTestLogger();

describe("kill-switch (EL-370)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __internals.cache.clear();
  });

  it("getKillSwitchStatus returns a paused=false default when row is missing", async () => {
    prisma.emailAccount.findUnique.mockResolvedValueOnce(null as any);
    const status = await getKillSwitchStatus("ea-1");
    expect(status).toEqual({
      paused: false,
      pausedAt: null,
      pausedBy: null,
      pauseReason: null,
    });
  });

  it("surfaces all four metadata fields when paused=true", async () => {
    const pausedAt = new Date("2026-05-04T13:00:00Z");
    prisma.emailAccount.findUnique.mockResolvedValueOnce({
      autonomousActionsPaused: true,
      autonomousActionsPausedAt: pausedAt,
      autonomousActionsPausedBy: "user-1",
      autonomousActionsPauseReason: "cleaning up",
    } as any);
    const status = await getKillSwitchStatus("ea-1", { skipCache: true });
    expect(status).toEqual({
      paused: true,
      pausedAt,
      pausedBy: "user-1",
      pauseReason: "cleaning up",
    });
  });

  it("caches consecutive calls within TTL (single DB hit)", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      autonomousActionsPaused: false,
      autonomousActionsPausedAt: null,
      autonomousActionsPausedBy: null,
      autonomousActionsPauseReason: null,
    } as any);

    await getKillSwitchStatus("ea-1");
    await getKillSwitchStatus("ea-1");
    await getKillSwitchStatus("ea-1");

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(1);
  });

  it("skipCache bypasses the cache", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      autonomousActionsPaused: false,
      autonomousActionsPausedAt: null,
      autonomousActionsPausedBy: null,
      autonomousActionsPauseReason: null,
    } as any);

    await getKillSwitchStatus("ea-1");
    await getKillSwitchStatus("ea-1", { skipCache: true });

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(2);
  });

  it("invalidateKillSwitchCache clears the specific entry", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      autonomousActionsPaused: false,
      autonomousActionsPausedAt: null,
      autonomousActionsPausedBy: null,
      autonomousActionsPauseReason: null,
    } as any);

    await getKillSwitchStatus("ea-1");
    invalidateKillSwitchCache("ea-1");
    await getKillSwitchStatus("ea-1");
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(2);
  });

  it("isAutonomousPaused returns the bool and uses the cache", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      autonomousActionsPaused: true,
      autonomousActionsPausedAt: new Date(),
      autonomousActionsPausedBy: "u1",
      autonomousActionsPauseReason: "r",
    } as any);
    await expect(isAutonomousPaused("ea-1")).resolves.toBe(true);
    await expect(isAutonomousPaused("ea-1")).resolves.toBe(true);
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(1);
  });

  describe("setAutonomousPaused", () => {
    it("persists paused=true with actor, reason, and a fresh timestamp + busts cache", async () => {
      // Pre-seed cache with paused=false
      prisma.emailAccount.findUnique.mockResolvedValueOnce({
        autonomousActionsPaused: false,
        autonomousActionsPausedAt: null,
        autonomousActionsPausedBy: null,
        autonomousActionsPauseReason: null,
      } as any);
      await getKillSwitchStatus("ea-1");

      const pausedAt = new Date();
      prisma.emailAccount.update.mockResolvedValueOnce({
        autonomousActionsPaused: true,
        autonomousActionsPausedAt: pausedAt,
        autonomousActionsPausedBy: "user-1",
        autonomousActionsPauseReason: "testing",
      } as any);

      const result = await setAutonomousPaused({
        emailAccountId: "ea-1",
        paused: true,
        reason: "testing",
        actor: "user-1",
        logger,
      });

      expect(result).toEqual({
        paused: true,
        pausedAt,
        pausedBy: "user-1",
        pauseReason: "testing",
      });

      const updateCall = prisma.emailAccount.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: "ea-1" });
      expect(updateCall.data).toMatchObject({
        autonomousActionsPaused: true,
        autonomousActionsPausedBy: "user-1",
        autonomousActionsPauseReason: "testing",
      });
      expect(updateCall.data.autonomousActionsPausedAt).toBeInstanceOf(Date);

      // Cache was invalidated \u2014 a subsequent read must hit Prisma.
      prisma.emailAccount.findUnique.mockResolvedValueOnce({
        autonomousActionsPaused: true,
        autonomousActionsPausedAt: pausedAt,
        autonomousActionsPausedBy: "user-1",
        autonomousActionsPauseReason: "testing",
      } as any);
      await getKillSwitchStatus("ea-1");
      expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(2);
    });

    it("persists paused=false by nulling all metadata", async () => {
      prisma.emailAccount.update.mockResolvedValueOnce({
        autonomousActionsPaused: false,
        autonomousActionsPausedAt: null,
        autonomousActionsPausedBy: null,
        autonomousActionsPauseReason: null,
      } as any);

      await setAutonomousPaused({
        emailAccountId: "ea-1",
        paused: false,
        actor: "user-1",
        logger,
      });

      const updateCall = prisma.emailAccount.update.mock.calls[0][0];
      expect(updateCall.data).toEqual({
        autonomousActionsPaused: false,
        autonomousActionsPausedAt: null,
        autonomousActionsPausedBy: null,
        autonomousActionsPauseReason: null,
      });
    });
  });
});
