/**
 * EL-473 — worker tests.
 *
 * The worker has two phases (evaluateRun / executeRun). We mock both
 * @/utils/prisma (in-memory store for BackfillRun + BackfillDecision)
 * and the email provider, then drive the worker through realistic
 * scenarios.
 *
 * What we explicitly verify:
 *   1. evaluateRun walks the sender shortlist, calls the evaluator
 *      per chunk, persists decisions, updates run counters, and
 *      transitions status correctly (dryRun vs auto-execute).
 *   2. Cooperative cancel — flipping run.status to "stopped" mid-run
 *      halts the loop without surfacing an error.
 *   3. Per-sender failure increments errorCount but doesn't abort
 *      the rest of the run.
 *   4. executeRun applies decisions via the provider, marks executedAt
 *      idempotently, never permanently deletes (TRASH uses trashThread,
 *      EL-459 invariant).
 *   5. SKIP rows are short-circuited as no-op but still get executedAt
 *      set so the run can transition to done.
 *   6. Per-decision error stays isolated — errorCount += 1, other
 *      decisions still execute.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

// In-memory mock store shared across the prisma mock + tests.
type Run = {
  id: string;
  emailAccountId: string;
  status: string;
  ruleIds: string[];
  dateFloor: Date | null;
  senderScope: string | null;
  modelId: string;
  dryRun: boolean;
  totalSenders: number;
  processedSenders: number;
  totalDecisions: number;
  executedDecisions: number;
  errorCount: number;
  currentSender: string | null;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  evaluatedAt: Date | null;
  executedAt: Date | null;
  completedAt: Date | null;
};
type Decision = {
  id: string;
  runId: string;
  messageId: string;
  threadId: string | null;
  sender: string;
  ruleId: string | null;
  action: string;
  labelName: string | null;
  reason: string;
  confidence: string;
  decidedAt: Date;
  executedAt: Date | null;
  executionError: string | null;
};

const store = {
  runs: new Map<string, Run>(),
  decisions: new Map<string, Decision>(),
  reset(): void {
    this.runs.clear();
    this.decisions.clear();
  },
};

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

vi.mock("@/utils/prisma", () => {
  const findMany = ({ where }: { where: Record<string, unknown> }) => {
    const rows = [...store.decisions.values()].filter((d) => {
      if (where.runId && d.runId !== where.runId) return false;
      if (where.executedAt === null && d.executedAt !== null) return false;
      if (where.executionError === null && d.executionError !== null)
        return false;
      const action = where.action as { not?: string } | string | undefined;
      if (typeof action === "string" && d.action !== action) return false;
      if (
        action &&
        typeof action === "object" &&
        action.not &&
        d.action === action.not
      )
        return false;
      return true;
    });
    return Promise.resolve(rows);
  };
  return {
    default: {
      backfillRun: {
        create: vi.fn(async ({ data }: { data: Partial<Run> }) => {
          const id = genId("br");
          const run: Run = {
            id,
            emailAccountId: data.emailAccountId ?? "_",
            status: data.status ?? "pending",
            ruleIds: data.ruleIds ?? [],
            dateFloor: data.dateFloor ?? null,
            senderScope: data.senderScope ?? null,
            modelId: data.modelId ?? "test-model",
            dryRun: data.dryRun ?? true,
            totalSenders: 0,
            processedSenders: 0,
            totalDecisions: 0,
            executedDecisions: 0,
            errorCount: 0,
            currentSender: null,
            lastError: null,
            createdAt: new Date(),
            startedAt: null,
            evaluatedAt: null,
            executedAt: null,
            completedAt: null,
          };
          store.runs.set(id, run);
          return run;
        }),
        findUnique: vi.fn(
          async ({ where }: { where: { id: string } }) =>
            store.runs.get(where.id) ?? null,
        ),
        findUniqueOrThrow: vi.fn(
          async ({ where }: { where: { id: string } }) => {
            const r = store.runs.get(where.id);
            if (!r) throw new Error("not found");
            return r;
          },
        ),
        update: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string };
            // biome-ignore lint/suspicious/noExplicitAny: test-side store accepts mixed update shapes
            data: any;
          }) => {
            const r = store.runs.get(where.id);
            if (!r) throw new Error("not found");
            const next: Run = { ...r };
            for (const [k, v] of Object.entries(data)) {
              if (
                v &&
                typeof v === "object" &&
                "increment" in (v as Record<string, unknown>) &&
                typeof (v as { increment: number }).increment === "number"
              ) {
                const inc = (v as { increment: number }).increment;
                (next as unknown as Record<string, number>)[k] =
                  ((next as unknown as Record<string, number>)[k] ?? 0) + inc;
              } else {
                (next as unknown as Record<string, unknown>)[k] = v;
              }
            }
            store.runs.set(where.id, next);
            return next;
          },
        ),
      },
      backfillDecision: {
        create: vi.fn(async ({ data }: { data: Partial<Decision> }) => {
          const id = genId("bd");
          const dec: Decision = {
            id,
            runId: data.runId ?? "_",
            messageId: data.messageId ?? "_",
            threadId: data.threadId ?? null,
            sender: data.sender ?? "_",
            ruleId: data.ruleId ?? null,
            action: data.action ?? "SKIP",
            labelName: data.labelName ?? null,
            reason: data.reason ?? "",
            confidence: data.confidence ?? "medium",
            decidedAt: new Date(),
            executedAt: null,
            executionError: null,
          };
          store.decisions.set(id, dec);
          return dec;
        }),
        createMany: vi.fn(
          async ({
            data,
            skipDuplicates,
          }: {
            data: Partial<Decision>[];
            skipDuplicates?: boolean;
          }) => {
            // EL-484: simulate the @@unique([runId, messageId]) constraint.
            // Postgres' INSERT ... ON CONFLICT DO NOTHING semantics: with
            // skipDuplicates=true, rows whose (runId, messageId) already
            // exist are silently dropped. Without skipDuplicates, attempting
            // to insert a duplicate would throw — but the worker always
            // passes skipDuplicates: true, so we don't model the throw path.
            let inserted = 0;
            for (const d of data) {
              if (skipDuplicates) {
                let exists = false;
                for (const existing of store.decisions.values()) {
                  if (
                    existing.runId === (d.runId ?? "_") &&
                    existing.messageId === (d.messageId ?? "_")
                  ) {
                    exists = true;
                    break;
                  }
                }
                if (exists) continue;
              }
              const id = genId("bd");
              store.decisions.set(id, {
                id,
                runId: d.runId ?? "_",
                messageId: d.messageId ?? "_",
                threadId: d.threadId ?? null,
                sender: d.sender ?? "_",
                ruleId: d.ruleId ?? null,
                action: d.action ?? "SKIP",
                labelName: d.labelName ?? null,
                reason: d.reason ?? "",
                confidence: d.confidence ?? "medium",
                decidedAt: new Date(),
                executedAt: null,
                executionError: null,
              });
              inserted += 1;
            }
            return { count: inserted };
          },
        ),
        findMany: vi.fn(
          async (args: {
            where: Record<string, unknown>;
            orderBy?: unknown;
            take?: number;
          }) => {
            let rows = await findMany(args);
            if (args.take) rows = rows.slice(0, args.take);
            return rows;
          },
        ),
        findFirstOrThrow: vi.fn(
          async (args: { where: Record<string, unknown> }) => {
            const rows = await findMany(args);
            if (rows.length === 0) throw new Error("no decision");
            return rows[0];
          },
        ),
        update: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string };
            data: Partial<Decision>;
          }) => {
            const d = store.decisions.get(where.id);
            if (!d) throw new Error("not found");
            const next = { ...d, ...data };
            store.decisions.set(where.id, next);
            return next;
          },
        ),
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: Record<string, unknown>;
            data: Partial<Decision>;
          }) => {
            let updated = 0;
            for (const [id, d] of store.decisions.entries()) {
              if (where.runId && d.runId !== where.runId) continue;
              if (where.executedAt === null && d.executedAt !== null) continue;
              if (where.action && d.action !== where.action) continue;
              store.decisions.set(id, { ...d, ...data });
              updated += 1;
            }
            return { count: updated };
          },
        ),
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          let n = 0;
          for (const d of store.decisions.values()) {
            if (where.runId && d.runId !== where.runId) continue;
            if (where.executedAt === null && d.executedAt !== null) continue;
            if (where.executionError === null && d.executionError !== null)
              continue;
            n += 1;
          }
          return n;
        }),
      },
      rule: {
        findMany: vi.fn(async () => []),
      },
      emailAccount: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "acct",
          email: "test@example.com",
          account: { provider: "google" },
        })),
      },
      $disconnect: vi.fn(async () => undefined),
    },
  };
});

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";
import { evaluateRun, executeRun } from "@/utils/backfill/worker";
import type { EvaluatorDecision } from "@/utils/backfill/evaluator";
import prisma from "@/utils/prisma";

const FIXTURE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "backfill-worker-fixture-"),
);
const FIXTURE_DB = path.join(FIXTURE_DIR, "mirror.db");

const NEWSLETTER = "newsletter@example.com";
const RECEIPTS = "receipts@vendor.com";

beforeAll(() => {
  if (fs.existsSync(FIXTURE_DB)) fs.unlinkSync(FIXTURE_DB);
  const db = new Database(FIXTURE_DB);
  db.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY, thread_id TEXT, subject TEXT,
      from_address TEXT, from_name TEXT, to_addresses TEXT,
      cc_addresses TEXT, date_sent INTEGER, labels TEXT,
      snippet TEXT, body_text TEXT, body_html_path TEXT,
      has_attachments INTEGER DEFAULT 0, attachment_metadata TEXT,
      raw_path TEXT, synced_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX idx_emails_date ON emails(date_sent);
    CREATE INDEX idx_emails_from ON emails(from_address);
  `);
  const insert = db.prepare(`
    INSERT INTO emails (id, thread_id, subject, from_address, snippet, body_text, labels, date_sent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < 3; i++) {
      insert.run(
        `nl-${i}`,
        `t-nl-${i}`,
        `Digest ${i}`,
        NEWSLETTER,
        "snip",
        "body",
        "INBOX",
        1_700_000_000 + i,
      );
    }
    for (let i = 0; i < 2; i++) {
      insert.run(
        `rc-${i}`,
        `t-rc-${i}`,
        `Receipt ${i}`,
        RECEIPTS,
        "snip",
        "body",
        "INBOX",
        1_710_000_000 + i,
      );
    }
  });
  tx();
  db.close();
});

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  store.reset();
});
afterEach(() => {
  vi.clearAllMocks();
});

const fakeRule = {
  id: "rule-1",
  name: "Newsletter archive",
  instructions: "archive",
  actions: [{ type: "ARCHIVE" }],
  enabled: true,
  runOnThreads: false,
  lockedToSenderId: null,
} as unknown as Awaited<ReturnType<typeof prisma.rule.findMany>>[number];

const fakeEmailAccount = {
  id: "_",
  email: "test@example.com",
  userId: "_",
  user: { aiProvider: null, aiModel: null, aiApiKey: null },
} as unknown as NonNullable<
  Awaited<ReturnType<typeof import("@/utils/user/get").getEmailAccountWithAi>>
>;

async function createRunInStore(
  opts: { ruleIds?: string[]; dryRun?: boolean; status?: string } = {},
) {
  return prisma.backfillRun.create({
    data: {
      emailAccountId: "acct",
      modelId: "test-model",
      dryRun: opts.dryRun ?? true,
      ruleIds: opts.ruleIds ?? ["rule-1"],
      status: opts.status,
    } as never,
  });
}

describe("evaluateRun", () => {
  it("walks senders, persists ARCHIVE decisions, transitions to awaiting_execution in dryRun mode", async () => {
    const run = await createRunInStore({ ruleIds: ["rule-1"] });
    (
      prisma.rule.findMany as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue([fakeRule]);

    const evaluate = vi.fn(
      async (args: {
        emails: { id: string }[];
      }): Promise<EvaluatorDecision[]> =>
        args.emails.map((e) => ({
          messageId: e.id,
          action: "ARCHIVE" as const,
          ruleId: "rule-1",
          reason: "newsletter",
          confidence: "high" as const,
        })),
    );

    await evaluateRun(run.id, {
      mirrorPath: FIXTURE_DB,
      evaluate: evaluate as unknown as NonNullable<
        Parameters<typeof evaluateRun>[1]
      >["evaluate"],
      loadEmailAccount: async () => fakeEmailAccount,
    });

    const updated = store.runs.get(run.id);
    expect(updated?.status).toBe("awaiting_execution");
    expect(updated?.totalSenders).toBe(2);
    expect(updated?.processedSenders).toBe(2);
    expect(updated?.totalDecisions).toBe(5);
    expect(updated?.evaluatedAt).toBeInstanceOf(Date);
    expect(updated?.currentSender).toBeNull();

    const decisions = [...store.decisions.values()].filter(
      (d) => d.runId === run.id,
    );
    expect(decisions).toHaveLength(5);
    expect(decisions.every((d) => d.action === "ARCHIVE")).toBe(true);
    expect(decisions.every((d) => d.executedAt === null)).toBe(true);
  });

  it("transitions to executing when dryRun is false", async () => {
    const run = await createRunInStore({ dryRun: false });
    (
      prisma.rule.findMany as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue([fakeRule]);

    const evaluate = async (args: { emails: { id: string }[] }) =>
      args.emails.map((e) => ({
        messageId: e.id,
        action: "SKIP" as const,
        ruleId: null,
        reason: "no match",
        confidence: "low" as const,
      }));

    await evaluateRun(run.id, {
      mirrorPath: FIXTURE_DB,
      evaluate: evaluate as unknown as NonNullable<
        Parameters<typeof evaluateRun>[1]
      >["evaluate"],
      loadEmailAccount: async () => fakeEmailAccount,
    });

    expect(store.runs.get(run.id)?.status).toBe("executing");
  });

  it("respects cooperative stop — flipping status to stopped halts the loop", async () => {
    const run = await createRunInStore();
    (
      prisma.rule.findMany as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue([fakeRule]);

    let calls = 0;
    const evaluate = async () => {
      calls += 1;
      const r = store.runs.get(run.id);
      if (r) {
        store.runs.set(run.id, { ...r, status: "stopped" });
      }
      return [];
    };

    await evaluateRun(run.id, {
      mirrorPath: FIXTURE_DB,
      evaluate: evaluate as unknown as NonNullable<
        Parameters<typeof evaluateRun>[1]
      >["evaluate"],
      loadEmailAccount: async () => fakeEmailAccount,
    });

    // Should have evaluated only the first sender, then halted.
    expect(calls).toBe(1);
    expect(store.runs.get(run.id)?.status).toBe("stopped");
  });

  it("isolates per-sender failures — increments errorCount and continues", async () => {
    const run = await createRunInStore();
    (
      prisma.rule.findMany as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue([fakeRule]);

    let nth = 0;
    const evaluate = async (args: { emails: { id: string }[] }) => {
      nth += 1;
      if (nth === 1) throw new Error("LLM hiccup");
      return args.emails.map((e) => ({
        messageId: e.id,
        action: "ARCHIVE" as const,
        ruleId: "rule-1",
        reason: "later sender ok",
        confidence: "high" as const,
      }));
    };

    await evaluateRun(run.id, {
      mirrorPath: FIXTURE_DB,
      evaluate: evaluate as unknown as NonNullable<
        Parameters<typeof evaluateRun>[1]
      >["evaluate"],
      loadEmailAccount: async () => fakeEmailAccount,
    });

    const updated = store.runs.get(run.id);
    expect(updated?.errorCount).toBe(1);
    expect(updated?.status).toBe("awaiting_execution");
    const decisions = [...store.decisions.values()].filter(
      (d) => d.runId === run.id,
    );
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.sender === RECEIPTS)).toBe(true);
  });

  it(
    "EL-484: re-running evaluateRun for the same run does not bloat " +
      "the audit table — relies on @@unique([runId, messageId])",
    async () => {
      const run = await createRunInStore({ ruleIds: ["rule-1"] });
      (
        prisma.rule.findMany as unknown as ReturnType<typeof vi.fn>
      ).mockResolvedValue([fakeRule]);

      // First-pass evaluator: emits ARCHIVE for every email; resets run
      // back to a re-evaluable state on completion to simulate a worker
      // restart that found the row in 'evaluating'.
      const evaluate = vi.fn(
        async (args: {
          emails: { id: string }[];
        }): Promise<EvaluatorDecision[]> =>
          args.emails.map((e) => ({
            messageId: e.id,
            action: "ARCHIVE" as const,
            ruleId: "rule-1",
            reason: "newsletter",
            confidence: "high" as const,
          })),
      );

      // Pass 1
      await evaluateRun(run.id, {
        mirrorPath: FIXTURE_DB,
        evaluate: evaluate as unknown as NonNullable<
          Parameters<typeof evaluateRun>[1]
        >["evaluate"],
        loadEmailAccount: async () => fakeEmailAccount,
      });

      const firstPassRows = [...store.decisions.values()].filter(
        (d) => d.runId === run.id,
      );
      const firstPassMessageIds = new Set(
        firstPassRows.map((d) => d.messageId),
      );
      expect(firstPassRows).toHaveLength(5);
      expect(firstPassMessageIds.size).toBe(5);

      // Simulate a process death + restart: flip status back to a
      // re-evaluable state and call evaluateRun again. With the unique
      // constraint in place (mocked above to honor skipDuplicates),
      // every (runId, messageId) row is dropped silently.
      const r = store.runs.get(run.id);
      if (r) {
        store.runs.set(run.id, {
          ...r,
          status: "evaluating",
          processedSenders: 0,
          totalDecisions: 0,
          evaluatedAt: null,
        });
      }

      await evaluateRun(run.id, {
        mirrorPath: FIXTURE_DB,
        evaluate: evaluate as unknown as NonNullable<
          Parameters<typeof evaluateRun>[1]
        >["evaluate"],
        loadEmailAccount: async () => fakeEmailAccount,
      });

      const secondPassRows = [...store.decisions.values()].filter(
        (d) => d.runId === run.id,
      );
      // No new rows were inserted — the unique constraint suppressed them.
      expect(secondPassRows).toHaveLength(5);
      // Every (runId, messageId) pair is unique.
      const seen = new Set<string>();
      for (const d of secondPassRows) {
        const key = `${d.runId}::${d.messageId}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      // Evaluator was called twice (once per pass) — confirms that the
      // dedup happens at the persist layer, not at the evaluator entry.
      expect(evaluate).toHaveBeenCalledTimes(4); // 2 senders × 2 passes
    },
  );
});

function fakeProvider() {
  return {
    archiveMessage: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    trashThread: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    labelMessage: vi.fn(async () => undefined),
  };
}

describe("executeRun", () => {
  it("applies ARCHIVE decisions via archiveThread, marks executedAt, transitions to done", async () => {
    const run = await createRunInStore({
      dryRun: true,
      status: "awaiting_execution",
    });
    await prisma.backfillDecision.createMany({
      data: [
        {
          runId: run.id,
          messageId: "m1",
          threadId: "th1",
          sender: NEWSLETTER,
          action: "ARCHIVE",
          ruleId: "rule-1",
          reason: "newsletter",
        },
        {
          runId: run.id,
          messageId: "m2",
          threadId: "th2",
          sender: NEWSLETTER,
          action: "ARCHIVE",
          ruleId: "rule-1",
          reason: "newsletter",
        },
      ] as never,
    });

    const provider = fakeProvider();
    await executeRun(
      run.id,
      {},
      {
        buildProvider: vi.fn(
          async () => provider,
        ) as unknown as typeof import("@/utils/email/provider").createEmailProvider,
      },
    );

    expect(provider.archiveThread).toHaveBeenCalledTimes(2);
    expect(provider.trashThread).not.toHaveBeenCalled();

    const updated = store.runs.get(run.id);
    expect(updated?.status).toBe("done");
    expect(updated?.executedDecisions).toBe(2);
    expect(updated?.completedAt).toBeInstanceOf(Date);
    const decs = [...store.decisions.values()].filter(
      (d) => d.runId === run.id,
    );
    expect(decs.every((d) => d.executedAt instanceof Date)).toBe(true);
  });

  it("uses trashThread (NOT batchModify) for TRASH — EL-459 invariant", async () => {
    const run = await createRunInStore({ status: "awaiting_execution" });
    await prisma.backfillDecision.create({
      data: {
        runId: run.id,
        messageId: "m1",
        threadId: "th1",
        sender: NEWSLETTER,
        action: "TRASH",
        ruleId: "rule-1",
        reason: "spam newsletter",
      } as never,
    });

    const provider = fakeProvider();
    await executeRun(
      run.id,
      {},
      {
        buildProvider: vi.fn(
          async () => provider,
        ) as unknown as typeof import("@/utils/email/provider").createEmailProvider,
      },
    );

    expect(provider.trashThread).toHaveBeenCalledTimes(1);
    expect(provider.trashThread).toHaveBeenCalledWith(
      "th1",
      expect.any(String),
      "automation",
    );
  });

  it("isolates per-decision failures — sets executionError and continues", async () => {
    const run = await createRunInStore({ status: "awaiting_execution" });
    await prisma.backfillDecision.createMany({
      data: [
        {
          runId: run.id,
          messageId: "m1",
          threadId: "th1",
          sender: NEWSLETTER,
          action: "ARCHIVE",
          ruleId: "rule-1",
          reason: "ok",
        },
        {
          runId: run.id,
          messageId: "m2",
          threadId: "th2",
          sender: NEWSLETTER,
          action: "ARCHIVE",
          ruleId: "rule-1",
          reason: "boom",
        },
      ] as never,
    });

    const provider = fakeProvider();
    provider.archiveThread = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Gmail 5xx"));

    await executeRun(
      run.id,
      {},
      {
        buildProvider: vi.fn(
          async () => provider,
        ) as unknown as typeof import("@/utils/email/provider").createEmailProvider,
      },
    );

    const decs = [...store.decisions.values()]
      .filter((d) => d.runId === run.id)
      .sort((a, b) => a.messageId.localeCompare(b.messageId));
    expect(decs[0].executedAt).toBeInstanceOf(Date);
    expect(decs[0].executionError).toBeNull();
    expect(decs[1].executedAt).toBeNull();
    expect(decs[1].executionError).toMatch(/Gmail 5xx/);

    const updated = store.runs.get(run.id);
    expect(updated?.errorCount).toBe(1);
    expect(updated?.executedDecisions).toBe(1);
    // Run is considered done because the only "unfinished" decision
    // already has an executionError. Re-running executeRun would NOT
    // retry the failed one (avoids infinite loops). A future "retry
    // failed" feature can clear executionError to put it back in queue.
    expect(updated?.status).toBe("done");
    expect(updated?.completedAt).toBeInstanceOf(Date);
  });

  it("auto-marks SKIP decisions as executed (no provider calls)", async () => {
    const run = await createRunInStore({ status: "awaiting_execution" });
    await prisma.backfillDecision.create({
      data: {
        runId: run.id,
        messageId: "m1",
        threadId: "th1",
        sender: NEWSLETTER,
        action: "SKIP",
        ruleId: null,
        reason: "no rule matched",
      } as never,
    });

    const provider = fakeProvider();
    await executeRun(
      run.id,
      {},
      {
        buildProvider: vi.fn(
          async () => provider,
        ) as unknown as typeof import("@/utils/email/provider").createEmailProvider,
      },
    );

    const skip = [...store.decisions.values()].find((d) => d.runId === run.id);
    expect(skip?.executedAt).toBeInstanceOf(Date);
    expect(provider.archiveThread).not.toHaveBeenCalled();
    expect(provider.trashThread).not.toHaveBeenCalled();
    expect(store.runs.get(run.id)?.status).toBe("done");
  });
});
