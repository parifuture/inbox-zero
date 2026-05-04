import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist-safe mock — the cache module imports `redis` from `@/utils/redis`.
vi.mock("@/utils/redis", () => {
  const store = new Map<string, { value: unknown; ex?: number }>();
  const calls: Array<{ cmd: string; args: unknown[] }> = [];
  const redis = {
    get: vi.fn(async (key: string) => {
      calls.push({ cmd: "get", args: [key] });
      return store.get(key)?.value ?? null;
    }),
    set: vi.fn(async (key: string, value: unknown, opts?: { ex?: number }) => {
      calls.push({ cmd: "set", args: [key, value, opts] });
      store.set(key, { value, ex: opts?.ex });
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      calls.push({ cmd: "del", args: keys });
      let n = 0;
      for (const k of keys) n += store.delete(k) ? 1 : 0;
      return n;
    }),
    scan: vi.fn(
      async (_cursor: string, opts: { match: string; count: number }) => {
        calls.push({ cmd: "scan", args: [_cursor, opts] });
        const prefix = opts.match.replace(/\*$/, "");
        const keys = Array.from(store.keys()).filter((k) =>
          k.startsWith(prefix),
        );
        return ["0", keys] as [string, string[]];
      },
    ),
    __store: store,
    __calls: calls,
    __reset() {
      store.clear();
      calls.length = 0;
    },
  };
  return { redis, expire: vi.fn() };
});

import { redis as mockRedis } from "@/utils/redis";
import {
  SENDER_DRILL_PARTIAL_TTL_SEC,
  SENDER_DRILL_SUCCESS_TTL_SEC,
  deriveSenderDrillLabelState,
  getCachedSenderDrill,
  invalidateSenderDrill,
  senderDrillCacheKey,
  senderDrillInvalidationPattern,
  setCachedSenderDrill,
  type SenderDrillCachePayload,
} from "./sender-drill-cache";

type MockRedis = typeof mockRedis & {
  __store: Map<string, { value: unknown; ex?: number }>;
  __calls: Array<{ cmd: string; args: unknown[] }>;
  __reset: () => void;
};

const r = mockRedis as unknown as MockRedis;

describe("sender-drill-cache", () => {
  beforeEach(() => {
    r.__reset();
  });

  describe("senderDrillCacheKey", () => {
    it("lowercases sender email and uses _ for null cursor", () => {
      const key = senderDrillCacheKey({
        emailAccountId: "acct1",
        senderEmail: "Foo@Bar.COM",
        cursor: null,
      });
      expect(key).toBe("sender-drill:acct1:foo@bar.com:_");
    });

    it("uses cursor token when provided", () => {
      const key = senderDrillCacheKey({
        emailAccountId: "acct1",
        senderEmail: "foo@bar.com",
        cursor: "ABC123",
      });
      expect(key).toBe("sender-drill:acct1:foo@bar.com:ABC123");
    });

    it("invalidation pattern matches every cursor for a sender", () => {
      const pattern = senderDrillInvalidationPattern({
        emailAccountId: "acct1",
        senderEmail: "FOO@bar.com",
      });
      expect(pattern).toBe("sender-drill:acct1:foo@bar.com:*");
    });
  });

  describe("deriveSenderDrillLabelState", () => {
    it("returns archived when labelIds is empty or missing", () => {
      expect(deriveSenderDrillLabelState(null)).toBe("archived");
      expect(deriveSenderDrillLabelState(undefined)).toBe("archived");
      expect(deriveSenderDrillLabelState([])).toBe("archived");
    });

    it("prioritizes TRASH over everything", () => {
      expect(deriveSenderDrillLabelState(["INBOX", "TRASH", "SENT"])).toBe(
        "trashed",
      );
    });

    it("prefers SENT over INBOX", () => {
      expect(deriveSenderDrillLabelState(["SENT", "INBOX"])).toBe("sent");
    });

    it("returns inbox when labelIds includes INBOX and no TRASH/SENT", () => {
      expect(deriveSenderDrillLabelState(["INBOX", "CATEGORY_PERSONAL"])).toBe(
        "inbox",
      );
    });

    it("returns archived when only non-state labels are present", () => {
      expect(
        deriveSenderDrillLabelState(["CATEGORY_PROMOTIONS", "UNREAD"]),
      ).toBe("archived");
    });
  });

  describe("set + get round-trip", () => {
    it("persists a successful payload with 24h TTL", async () => {
      const payload: SenderDrillCachePayload = {
        messages: [
          {
            id: "m1",
            threadId: "t1",
            date: "2022-01-01",
            subject: "hi",
            snippet: "...",
            labelState: "archived",
          },
        ],
        nextPageToken: "NEXT",
        fetchedAt: new Date().toISOString(),
        partial: false,
      };

      await setCachedSenderDrill(
        { emailAccountId: "acct1", senderEmail: "foo@bar.com", cursor: null },
        payload,
      );

      const setCall = r.__calls.find((c) => c.cmd === "set");
      expect(setCall?.args[2]).toEqual({ ex: SENDER_DRILL_SUCCESS_TTL_SEC });

      const roundTrip = await getCachedSenderDrill({
        emailAccountId: "acct1",
        senderEmail: "foo@bar.com",
        cursor: null,
      });
      expect(roundTrip).toEqual(payload);
    });

    it("partial payloads get the 5-minute TTL", async () => {
      const payload: SenderDrillCachePayload = {
        messages: [],
        nextPageToken: null,
        fetchedAt: new Date().toISOString(),
        partial: true,
      };
      await setCachedSenderDrill(
        { emailAccountId: "acct1", senderEmail: "foo@bar.com", cursor: null },
        payload,
      );
      const setCall = r.__calls.find((c) => c.cmd === "set");
      expect(setCall?.args[2]).toEqual({ ex: SENDER_DRILL_PARTIAL_TTL_SEC });
    });

    it("get returns null when nothing cached", async () => {
      const result = await getCachedSenderDrill({
        emailAccountId: "acct1",
        senderEmail: "foo@bar.com",
        cursor: null,
      });
      expect(result).toBeNull();
    });

    it("get treats malformed entries as missing", async () => {
      // Inject malformed entry directly
      r.__store.set("sender-drill:acct1:foo@bar.com:_", {
        value: { messages: "not-an-array" },
      });
      const result = await getCachedSenderDrill({
        emailAccountId: "acct1",
        senderEmail: "foo@bar.com",
        cursor: null,
      });
      expect(result).toBeNull();
    });
  });

  describe("invalidateSenderDrill", () => {
    it("deletes every cached page for a sender regardless of cursor", async () => {
      const fetchedAt = new Date().toISOString();
      await setCachedSenderDrill(
        { emailAccountId: "acct1", senderEmail: "foo@bar.com", cursor: null },
        { messages: [], nextPageToken: null, fetchedAt, partial: false },
      );
      await setCachedSenderDrill(
        { emailAccountId: "acct1", senderEmail: "foo@bar.com", cursor: "AAA" },
        { messages: [], nextPageToken: null, fetchedAt, partial: false },
      );
      await setCachedSenderDrill(
        { emailAccountId: "acct1", senderEmail: "foo@bar.com", cursor: "BBB" },
        { messages: [], nextPageToken: null, fetchedAt, partial: false },
      );
      // Unrelated sender shouldn't be touched.
      await setCachedSenderDrill(
        { emailAccountId: "acct1", senderEmail: "other@bar.com", cursor: null },
        { messages: [], nextPageToken: null, fetchedAt, partial: false },
      );

      const deleted = await invalidateSenderDrill({
        emailAccountId: "acct1",
        senderEmail: "FOO@bar.com",
      });
      expect(deleted).toBe(3);

      // Unrelated sender still there
      expect(
        await getCachedSenderDrill({
          emailAccountId: "acct1",
          senderEmail: "other@bar.com",
          cursor: null,
        }),
      ).not.toBeNull();
    });

    it("returns 0 when there is nothing matching", async () => {
      const deleted = await invalidateSenderDrill({
        emailAccountId: "acct1",
        senderEmail: "ghost@bar.com",
      });
      expect(deleted).toBe(0);
    });
  });
});
