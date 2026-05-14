import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");

vi.mock("@/utils/middleware", () => ({
  withEmailAccount:
    (
      _scope: string,
      handler: (
        request: Request & { auth: { emailAccountId: string } },
      ) => Promise<Response>,
    ) =>
    async (request: Request) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "email-account-1" },
        }),
      ),
  withEmailProvider:
    (
      _scope: string,
      handler: (
        request: Request & {
          auth: { emailAccountId: string };
          emailProvider: { name: string };
          logger: {
            info: (...args: unknown[]) => void;
            warn: (...args: unknown[]) => void;
          };
        },
      ) => Promise<Response>,
    ) =>
    async (request: Request) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "email-account-1" },
          emailProvider: { name: "google" },
          logger: { info: vi.fn(), warn: vi.fn() },
        }),
      ),
}));

vi.mock("@/utils/kill-switch", () => ({
  getKillSwitchStatus: vi.fn(async () => ({ paused: false })),
}));

import { GET } from "./route";

describe("GET /api/historical-senders/sent-history (EL-432)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockQueryRaw({
    truthRows,
    aggregateRows,
    vipRows,
  }: {
    truthRows: unknown[];
    aggregateRows: unknown[];
    vipRows: unknown[];
  }) {
    let call = 0;
    (
      prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve(truthRows);
      if (call === 2) return Promise.resolve(aggregateRows);
      if (call === 3) return Promise.resolve(vipRows);
      return Promise.resolve([]);
    });
  }

  it("returns the merged shape with exclusion flags populated", async () => {
    mockQueryRaw({
      truthRows: [
        {
          sender_email: "newsletter@somecorp.com",
          category: "marketing",
          action: "archive",
          evidence: { sent_count: 1, last_sent: "2020-01-01T00:00:00Z" },
        },
        {
          sender_email: "alice@gmail.com",
          category: "personal",
          action: "archive",
          evidence: { sent_count: 5, last_sent: "2019-01-01T00:00:00Z" },
        },
        {
          sender_email: "alerts@chase.com",
          category: "bank",
          action: "archive",
          evidence: { sent_count: 1, last_sent: "2018-01-01T00:00:00Z" },
        },
        {
          sender_email: "ceo@somecorp.com",
          category: "marketing",
          action: "archive",
          evidence: { sent_count: 1, last_sent: "2018-01-01T00:00:00Z" },
        },
      ],
      aggregateRows: [
        {
          address: "newsletter@somecorp.com",
          total_received_from: 12,
          last_received: "2020-02-01",
        },
      ],
      vipRows: [{ address: "ceo@somecorp.com", domain: null }],
    });

    (
      prisma.newsletter.findMany as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([
      {
        email: "newsletter@somecorp.com",
        name: "SomeCorp",
        category: { name: "Newsletters" },
      },
    ]);

    const request = new Request(
      "http://localhost/api/historical-senders/sent-history",
    );
    const response = await GET(
      request as never,
      {
        params: Promise.resolve({}),
      } as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.totals.candidates).toBe(4);
    expect(body.killSwitchPaused).toBe(false);

    const bySender: Record<string, (typeof body.senders)[number]> =
      Object.fromEntries(
        body.senders.map((s: { senderEmail: string }) => [s.senderEmail, s]),
      );
    expect(bySender["alice@gmail.com"].exclusionReason).toBe("personal_domain");
    expect(bySender["alerts@chase.com"].exclusionReason).toBe(
      "protected_class",
    );
    expect(bySender["ceo@somecorp.com"].exclusionReason).toBe("vip");
    expect(bySender["newsletter@somecorp.com"].exclusionReason).toBeNull();
    expect(bySender["newsletter@somecorp.com"].senderName).toBe("SomeCorp");
    expect(bySender["newsletter@somecorp.com"].category).toBe("Newsletters");
    expect(bySender["newsletter@somecorp.com"].receivedCount).toBe(12);

    expect(body.totals.willKeep).toBe(3);
    expect(body.totals.willArchive).toBe(1);
    expect(body.totals.byReason.vip).toBe(1);
    expect(body.totals.byReason.protected_class).toBe(1);
    expect(body.totals.byReason.personal_domain).toBe(1);
  });

  it("handles empty truth set (no candidates)", async () => {
    mockQueryRaw({ truthRows: [], aggregateRows: [], vipRows: [] });
    (
      prisma.newsletter.findMany as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([]);

    const request = new Request(
      "http://localhost/api/historical-senders/sent-history",
    );
    const response = await GET(
      request as never,
      { params: Promise.resolve({}) } as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.senders).toEqual([]);
    expect(body.totals.candidates).toBe(0);
    expect(body.totals.willArchive).toBe(0);
    expect(body.totals.willKeep).toBe(0);
  });

  it("flags VIP by domain match, not just address", async () => {
    mockQueryRaw({
      truthRows: [
        {
          sender_email: "anyone@vipcorp.com",
          category: "personal",
          action: "archive",
          evidence: { sent_count: 1 },
        },
      ],
      aggregateRows: [],
      vipRows: [{ address: null, domain: "vipcorp.com" }],
    });
    (
      prisma.newsletter.findMany as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([]);

    const request = new Request(
      "http://localhost/api/historical-senders/sent-history",
    );
    const response = await GET(
      request as never,
      { params: Promise.resolve({}) } as never,
    );
    const body = await response.json();
    expect(body.senders[0].exclusionReason).toBe("vip");
  });

  it("filters truth query to action='archive' (excludes already-kept rows)", async () => {
    // We can't observe the SQL string here, but we ensure that if upstream
    // returned only archive rows, none of those become 'keep'-marked in output.
    mockQueryRaw({
      truthRows: [
        {
          sender_email: "newsletter@somecorp.com",
          category: "marketing",
          action: "archive",
          evidence: { sent_count: 1 },
        },
      ],
      aggregateRows: [],
      vipRows: [],
    });
    (
      prisma.newsletter.findMany as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([]);

    const request = new Request(
      "http://localhost/api/historical-senders/sent-history",
    );
    const response = await GET(
      request as never,
      { params: Promise.resolve({}) } as never,
    );
    const body = await response.json();
    expect(body.senders).toHaveLength(1);
    expect(body.senders[0].excluded).toBe(false);
  });

  it("propagates killSwitchPaused=true into the response body", async () => {
    const killSwitch = await import("@/utils/kill-switch");
    (
      killSwitch.getKillSwitchStatus as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ paused: true });
    mockQueryRaw({ truthRows: [], aggregateRows: [], vipRows: [] });
    (
      prisma.newsletter.findMany as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([]);

    const request = new Request(
      "http://localhost/api/historical-senders/sent-history",
    );
    const response = await GET(
      request as never,
      { params: Promise.resolve({}) } as never,
    );
    const body = await response.json();
    expect(body.killSwitchPaused).toBe(true);
  });
});
