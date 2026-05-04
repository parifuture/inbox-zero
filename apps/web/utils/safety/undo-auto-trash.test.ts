import { describe, it, expect, vi } from "vitest";
import {
  chunk,
  MAX_COUNT_PER_CALL,
  untrashMessages,
  UNTRASH_CHUNK_SIZE,
  validateFilter,
} from "./undo-auto-trash";
import { createTestLogger } from "@/__tests__/helpers";

const logger = createTestLogger();

describe("undo-auto-trash (EL-367)", () => {
  describe("validateFilter", () => {
    it("requires one of minutes or count", () => {
      expect(validateFilter({})).toMatch(/minutes.*count/);
    });
    it("rejects both minutes and count", () => {
      expect(validateFilter({ minutes: 10, count: 20 })).toMatch(/exactly one/);
    });
    it("rejects count > MAX_COUNT_PER_CALL", () => {
      expect(validateFilter({ count: MAX_COUNT_PER_CALL + 1 })).toMatch(
        /\u2264/,
      );
    });
    it("rejects minutes > 24h", () => {
      expect(validateFilter({ minutes: 10_000 })).toMatch(/1440|24h/);
    });
    it("accepts a valid minutes filter", () => {
      expect(validateFilter({ minutes: 15 })).toBeNull();
    });
    it("accepts a valid count filter", () => {
      expect(validateFilter({ count: 50 })).toBeNull();
    });
  });

  describe("chunk", () => {
    it("chunks evenly", () => {
      expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });
  });

  describe("untrashMessages", () => {
    it("no-ops with empty input", async () => {
      const batchUntrash = vi.fn();
      const result = await untrashMessages({
        messageIds: [],
        logger,
        deps: { gmail: {} as any, batchUntrash, sleepMs: async () => {} },
      });
      expect(result.attempted).toBe(0);
      expect(result.restored).toBe(0);
      expect(batchUntrash).not.toHaveBeenCalled();
    });

    it("chunks to 1000 per batchModify call, sleeps between chunks", async () => {
      const ids = Array.from(
        { length: UNTRASH_CHUNK_SIZE + 3 },
        (_, i) => `m${i}`,
      );
      const batchUntrash = vi.fn().mockResolvedValue(undefined);
      const sleepMs = vi.fn().mockResolvedValue(undefined);

      const result = await untrashMessages({
        messageIds: ids,
        logger,
        deps: { gmail: {} as any, batchUntrash, sleepMs },
      });

      expect(result.attempted).toBe(UNTRASH_CHUNK_SIZE + 3);
      expect(result.restored).toBe(UNTRASH_CHUNK_SIZE + 3);
      expect(batchUntrash).toHaveBeenCalledTimes(2);
      expect(batchUntrash.mock.calls[0][0]).toHaveLength(UNTRASH_CHUNK_SIZE);
      expect(batchUntrash.mock.calls[1][0]).toHaveLength(3);
      expect(sleepMs).toHaveBeenCalledTimes(1);
    });

    it("caps messageIds in the response at 100 even if more were restored", async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
      const batchUntrash = vi.fn().mockResolvedValue(undefined);
      const result = await untrashMessages({
        messageIds: ids,
        logger,
        deps: { gmail: {} as any, batchUntrash, sleepMs: async () => {} },
      });
      expect(result.restored).toBe(250);
      expect(result.messageIds).toHaveLength(100);
    });

    it("classifies a 'not found' error without stalling the rest", async () => {
      const ids = Array.from({ length: 5 }, (_, i) => `m${i}`);
      const batchUntrash = vi
        .fn()
        .mockRejectedValueOnce(new Error("Not found"));
      const result = await untrashMessages({
        messageIds: ids,
        logger,
        deps: { gmail: {} as any, batchUntrash, sleepMs: async () => {} },
      });
      expect(result.notFound).toBe(5);
      expect(result.failed).toBe(0);
      expect(result.restored).toBe(0);
    });

    it("classifies other errors as failed", async () => {
      const ids = Array.from({ length: 5 }, (_, i) => `m${i}`);
      const batchUntrash = vi
        .fn()
        .mockRejectedValueOnce(new Error("gmail 500"));
      const result = await untrashMessages({
        messageIds: ids,
        logger,
        deps: { gmail: {} as any, batchUntrash, sleepMs: async () => {} },
      });
      expect(result.failed).toBe(5);
      expect(result.notFound).toBe(0);
    });
  });
});
