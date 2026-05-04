/**
 * EL-358b \u2014 sender-aggregate unit tests.
 *
 * Prisma is mocked so we can assert the shape of the aggregate without
 * standing up Postgres. The important invariants:
 *
 *  - cold-start (no rows) returns null
 *  - reply count / last-replied are derived from ResponseTime, not guessed
 *  - initiation ratio math matches the sidecar (sent / (sent + received))
 *  - domain is lowercased
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/prisma", () => {
  const prisma = {
    emailMessage: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
    responseTime: { aggregate: vi.fn() },
  };
  return { default: prisma };
});

import { buildSenderAggregate } from "./sender-aggregate";
import prisma from "@/utils/prisma";

describe("buildSenderAggregate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for a sender we've never seen", async () => {
    (prisma.emailMessage.aggregate as any).mockResolvedValue({
      _count: { _all: 0 },
      _min: { date: null },
      _max: { date: null },
    });
    (prisma.emailMessage.count as any).mockResolvedValue(0);
    (prisma.emailMessage.findMany as any).mockResolvedValue([]);

    const agg = await buildSenderAggregate("acc_1", "ghost@nowhere.io");
    expect(agg).toBeNull();
  });

  it("derives reply count + last replied from ResponseTime", async () => {
    const firstSeen = new Date("2025-01-01");
    const lastReceived = new Date("2025-03-01");
    const lastReplied = new Date("2025-02-15");

    (prisma.emailMessage.aggregate as any).mockResolvedValue({
      _count: { _all: 4 },
      _min: { date: firstSeen },
      _max: { date: lastReceived },
    });
    (prisma.emailMessage.count as any).mockResolvedValue(2);
    (prisma.emailMessage.findMany as any).mockResolvedValue([
      { messageId: "<a@x>" },
      { messageId: "<b@x>" },
      { messageId: "<c@x>" },
      { messageId: "<d@x>" },
    ]);
    (prisma.responseTime.aggregate as any).mockResolvedValue({
      _count: { _all: 2 },
      _max: { sentAt: lastReplied },
    });

    const agg = await buildSenderAggregate("acc_1", "friend@Example.COM");
    expect(agg).not.toBeNull();
    expect(agg!.replyCount).toBe(2);
    expect(agg!.lastReplied).toEqual(lastReplied);
    expect(agg!.totalReceivedFrom).toBe(4);
    expect(agg!.totalSentToThem).toBe(2);
    expect(agg!.firstSeen).toEqual(firstSeen);
    expect(agg!.lastReceived).toEqual(lastReceived);
    // initiationRatio = sent / (sent + received) = 2/6 \u2248 0.333
    expect(agg!.initiationRatio).toBeCloseTo(2 / 6, 5);
  });

  it("skips ResponseTime lookup when there are no received messages", async () => {
    (prisma.emailMessage.aggregate as any).mockResolvedValue({
      _count: { _all: 0 },
      _min: { date: null },
      _max: { date: null },
    });
    (prisma.emailMessage.count as any).mockResolvedValue(3);
    (prisma.emailMessage.findMany as any).mockResolvedValue([]);

    const agg = await buildSenderAggregate("acc_1", "outbound@only.org");
    expect(agg).not.toBeNull();
    expect(agg!.replyCount).toBe(0);
    expect(agg!.lastReplied).toBeNull();
    expect(prisma.responseTime.aggregate).not.toHaveBeenCalled();
    // With sent=3, received=0, ratio = 1.0 (we always initiate).
    expect(agg!.initiationRatio).toBe(1);
  });

  it("lowercases the sender domain", async () => {
    (prisma.emailMessage.aggregate as any).mockResolvedValue({
      _count: { _all: 1 },
      _min: { date: new Date() },
      _max: { date: new Date() },
    });
    (prisma.emailMessage.count as any).mockResolvedValue(0);
    (prisma.emailMessage.findMany as any).mockResolvedValue([
      { messageId: "<m@x>" },
    ]);
    (prisma.responseTime.aggregate as any).mockResolvedValue({
      _count: { _all: 0 },
      _max: { sentAt: null },
    });

    const agg = await buildSenderAggregate("acc_1", "x@MIXED.Case");
    expect(agg!.domain).toBe("mixed.case");
  });
});
