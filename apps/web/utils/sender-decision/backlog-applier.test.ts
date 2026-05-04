import { describe, it, expect, vi } from "vitest";
import {
  BATCH_MODIFY_CHUNK_SIZE,
  buildApplierPlan,
  chunk,
  isApplierAction,
  runApplierSideEffects,
} from "./backlog-applier";
import { createTestLogger } from "@/__tests__/helpers";
import { GmailLabel } from "@/utils/gmail/label";

const logger = createTestLogger();

describe("buildApplierPlan", () => {
  it("auto_trash excludes sent, trash, starred; adds TRASH, removes INBOX", () => {
    const plan = buildApplierPlan("foo@bar.com", "auto_trash");
    expect(plan.query).toBe("from:foo@bar.com -in:sent -is:starred -in:trash");
    expect(plan.mutation).toEqual({
      addLabelIds: [GmailLabel.TRASH],
      removeLabelIds: [GmailLabel.INBOX],
    });
  });

  it("auto_archive targets only inbox, removes INBOX, preserves starred/sent", () => {
    const plan = buildApplierPlan("foo@bar.com", "auto_archive");
    expect(plan.query).toBe("from:foo@bar.com -in:sent -is:starred in:inbox");
    expect(plan.mutation).toEqual({
      addLabelIds: [],
      removeLabelIds: [GmailLabel.INBOX],
    });
  });

  it("always_keep un-trashes prior auto-trashed mail", () => {
    const plan = buildApplierPlan("foo@bar.com", "always_keep");
    expect(plan.query).toBe("from:foo@bar.com -in:sent -is:starred in:trash");
    expect(plan.mutation).toEqual({
      addLabelIds: [GmailLabel.INBOX],
      removeLabelIds: [GmailLabel.TRASH],
    });
  });
});

describe("isApplierAction", () => {
  it("accepts the three applier actions and rejects review", () => {
    expect(isApplierAction("auto_trash")).toBe(true);
    expect(isApplierAction("auto_archive")).toBe(true);
    expect(isApplierAction("always_keep")).toBe(true);
    expect(isApplierAction("review")).toBe(false);
  });
});

describe("chunk", () => {
  it("chunks evenly and handles remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("empty in empty out", () => {
    expect(chunk<number>([], 2)).toEqual([]);
  });
});

describe("runApplierSideEffects", () => {
  it("no-ops and reports zero when no messages match", async () => {
    const batchModify = vi.fn();
    const result = await runApplierSideEffects({
      senderEmail: "foo@bar.com",
      action: "auto_trash",
      logger,
      deps: {
        gmail: {} as any,
        listMessageIds: async () => [],
        batchModify,
        sleepMs: async () => {},
      },
    });
    expect(result).toEqual({
      query: "from:foo@bar.com -in:sent -is:starred -in:trash",
      total: 0,
      processed: 0,
    });
    expect(batchModify).not.toHaveBeenCalled();
  });

  it("chunks to 1000 ids per batch and sleeps between chunks", async () => {
    const ids = Array.from(
      { length: BATCH_MODIFY_CHUNK_SIZE + 5 },
      (_, i) => `m${i}`,
    );
    const batchModify = vi.fn().mockResolvedValue(undefined);
    const sleepMs = vi.fn().mockResolvedValue(undefined);

    const result = await runApplierSideEffects({
      senderEmail: "foo@bar.com",
      action: "auto_trash",
      logger,
      deps: {
        gmail: {} as any,
        listMessageIds: async () => ids,
        batchModify,
        sleepMs,
      },
    });

    expect(result.total).toBe(BATCH_MODIFY_CHUNK_SIZE + 5);
    expect(result.processed).toBe(BATCH_MODIFY_CHUNK_SIZE + 5);
    expect(batchModify).toHaveBeenCalledTimes(2);
    expect(batchModify.mock.calls[0][0].ids).toHaveLength(
      BATCH_MODIFY_CHUNK_SIZE,
    );
    expect(batchModify.mock.calls[1][0].ids).toHaveLength(5);
    // 1 sleep between the 2 chunks, none after the last.
    expect(sleepMs).toHaveBeenCalledTimes(1);
    // Each batch sends the auto_trash mutation.
    expect(batchModify.mock.calls[0][0].mutation).toEqual({
      addLabelIds: [GmailLabel.TRASH],
      removeLabelIds: [GmailLabel.INBOX],
    });
  });

  it("auto_archive passes INBOX removal with no add labels", async () => {
    const batchModify = vi.fn().mockResolvedValue(undefined);
    await runApplierSideEffects({
      senderEmail: "foo@bar.com",
      action: "auto_archive",
      logger,
      deps: {
        gmail: {} as any,
        listMessageIds: async () => ["m1", "m2"],
        batchModify,
        sleepMs: async () => {},
      },
    });
    expect(batchModify).toHaveBeenCalledWith({
      ids: ["m1", "m2"],
      mutation: {
        addLabelIds: [],
        removeLabelIds: [GmailLabel.INBOX],
      },
    });
  });

  it("always_keep un-trashes", async () => {
    const batchModify = vi.fn().mockResolvedValue(undefined);
    await runApplierSideEffects({
      senderEmail: "foo@bar.com",
      action: "always_keep",
      logger,
      deps: {
        gmail: {} as any,
        listMessageIds: async () => ["m1"],
        batchModify,
        sleepMs: async () => {},
      },
    });
    expect(batchModify).toHaveBeenCalledWith({
      ids: ["m1"],
      mutation: {
        addLabelIds: [GmailLabel.INBOX],
        removeLabelIds: [GmailLabel.TRASH],
      },
    });
  });

  it("propagates batchModify errors so the job can be marked failed", async () => {
    const batchModify = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      runApplierSideEffects({
        senderEmail: "foo@bar.com",
        action: "auto_trash",
        logger,
        deps: {
          gmail: {} as any,
          listMessageIds: async () => ["m1"],
          batchModify,
          sleepMs: async () => {},
        },
      }),
    ).rejects.toThrow("boom");
  });
});
