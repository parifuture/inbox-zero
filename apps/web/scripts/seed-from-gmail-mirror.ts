/**
 * EL-385 — Seed SenderDecision rows from the local gmail-mirror SQLite corpus.
 *
 * gmail-mirror (~/code/gmail-mirror/gmail-mirror.db) holds the full Gmail
 * history with per-message from/date/labels. We use it to:
 *
 *   1. Aggregate the top-N senders by volume.
 *   2. If the sidecar `sender_truth` table is reachable, reuse its
 *      classification for any sender that exists there (same mapping as
 *      `seed-sender-decision.ts`).
 *   3. Otherwise, write the row as `action='review'` so Chotu can triage it.
 *
 * Every write is idempotent and safe:
 *   - Goes through `changeSenderDecision` (EL-365 guardrail, audit log,
 *     structured stdout line).
 *   - `source='seed'` on every row.
 *   - Never touches an existing `SenderDecision` row (skip-existing).
 *   - Never writes `auto_trash`. Uncertain senders default to `review`.
 *
 * Run:
 *
 *   pnpm tsx scripts/seed-from-gmail-mirror.ts \
 *     --email-account pari.future@gmail.com \
 *     --limit 500 \
 *     --dry-run
 *
 *   # apply for real:
 *   pnpm tsx scripts/seed-from-gmail-mirror.ts \
 *     --email-account pari.future@gmail.com --limit 500 --apply
 *
 * Optional:
 *   --db <path>                 override gmail-mirror.db path
 *   SIDECAR_DATABASE_URL=...    use sidecar sender_truth for better mapping
 */

import { DatabaseSync } from "node:sqlite";
import * as os from "node:os";
import * as path from "node:path";
import { Client as PgClient } from "pg";
import prisma from "@/utils/prisma";
import {
  canonicalizeSender,
  extractDomainFromEmailSafe,
  mapSidecarAction,
  parseArgs,
  type MirrorSenderRow,
  type SidecarTruthRow,
} from "./seed-from-gmail-mirror.lib";
import { changeSenderDecision } from "@/utils/sender-decision/change";
import type { SenderAction } from "@/generated/prisma/enums";

const DEFAULT_DB =
  process.env.GMAIL_MIRROR_DB ||
  path.join(os.homedir(), "code/gmail-mirror/gmail-mirror.db");

type Opts = {
  dbPath: string;
  limit: number;
  emailAccount?: string;
  accountId?: string;
  apply: boolean; // default false -> dry-run
};

function parseCliOpts(argv: string[]): Opts {
  const parsed = parseArgs(argv, {
    string: ["db", "email-account", "account-id"],
    number: ["limit"],
    boolean: ["apply", "dry-run"],
  });
  return {
    dbPath: (parsed.db as string) || DEFAULT_DB,
    limit: (parsed.limit as number) || 500,
    emailAccount: parsed["email-account"] as string | undefined,
    accountId: parsed["account-id"] as string | undefined,
    // Default to dry-run unless --apply is passed.
    apply: parsed.apply === true && parsed["dry-run"] !== true,
  };
}

async function resolveEmailAccountId(opts: Opts): Promise<string> {
  if (opts.accountId) return opts.accountId;
  if (!opts.emailAccount) {
    throw new Error(
      "Must supply --account-id <cuid> or --email-account <email>.",
    );
  }
  const acc = await prisma.emailAccount.findUnique({
    where: { email: opts.emailAccount.toLowerCase() },
    select: { id: true },
  });
  if (!acc) {
    throw new Error(`No EmailAccount for ${opts.emailAccount}`);
  }
  return acc.id;
}

/**
 * Pull top-N senders from gmail-mirror by message count.
 *
 * gmail-mirror schema (see ~/code/gmail-mirror/src/db.ts):
 *   emails(id, thread_id, subject, from_address, from_name, to_addresses,
 *          cc_addresses, date_sent, labels, snippet, body_text, ...).
 */
export function queryTopSenders(
  db: Pick<DatabaseSync, "prepare">,
  limit: number,
): MirrorSenderRow[] {
  const stmt = db.prepare(
    `SELECT
       from_address AS fromAddress,
       COUNT(*)     AS messageCount,
       MIN(date_sent) AS firstSeenEpoch,
       MAX(date_sent) AS lastSeenEpoch
     FROM emails
     WHERE from_address IS NOT NULL AND from_address != ''
     GROUP BY lower(from_address)
     ORDER BY messageCount DESC
     LIMIT ?`,
  );
  // node:sqlite returns plain rows; coerce numeric fields defensively.
  const rows = stmt.all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    fromAddress: String(r.fromAddress ?? ""),
    messageCount: Number(r.messageCount ?? 0),
    firstSeenEpoch: r.firstSeenEpoch == null ? null : Number(r.firstSeenEpoch),
    lastSeenEpoch: r.lastSeenEpoch == null ? null : Number(r.lastSeenEpoch),
  }));
}

async function fetchSidecarTruthMap(
  sidecarUrl: string,
): Promise<Map<string, SidecarTruthRow>> {
  const client = new PgClient({ connectionString: sidecarUrl });
  await client.connect();
  try {
    const res = await client.query<{
      sender_email: string;
      category: string | null;
      action: string | null;
      source: string | null;
    }>("SELECT sender_email, category, action, source FROM sender_truth");
    const m = new Map<string, SidecarTruthRow>();
    for (const r of res.rows) {
      const canon = canonicalizeSender(r.sender_email ?? "");
      if (!canon) continue;
      m.set(canon, {
        senderEmail: canon,
        category: r.category,
        action: r.action,
        source: r.source,
      });
    }
    return m;
  } finally {
    await client.end();
  }
}

function epochToDate(epoch: number | null): Date | null {
  if (epoch == null || !Number.isFinite(epoch)) return null;
  // gmail-mirror stores seconds in date_sent.
  return new Date(epoch * 1000);
}

async function main() {
  const opts = parseCliOpts(process.argv.slice(2));
  console.log("[seed-from-gmail-mirror] opts", {
    dbPath: opts.dbPath,
    limit: opts.limit,
    emailAccount: opts.emailAccount,
    accountId: opts.accountId,
    mode: opts.apply ? "APPLY" : "DRY-RUN",
  });

  const emailAccountId = await resolveEmailAccountId(opts);
  console.log(`[seed-from-gmail-mirror] target EmailAccount=${emailAccountId}`);

  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  let rows: MirrorSenderRow[];
  try {
    rows = queryTopSenders(db, opts.limit);
  } finally {
    db.close();
  }
  console.log(
    `[seed-from-gmail-mirror] pulled ${rows.length} sender aggregates from ${opts.dbPath}`,
  );

  // Optional sidecar enrichment.
  let sidecarMap: Map<string, SidecarTruthRow> = new Map();
  const sidecarUrl = process.env.SIDECAR_DATABASE_URL;
  if (sidecarUrl) {
    try {
      sidecarMap = await fetchSidecarTruthMap(sidecarUrl);
      console.log(
        `[seed-from-gmail-mirror] sidecar sender_truth rows=${sidecarMap.size}`,
      );
    } catch (err) {
      console.warn(
        `[seed-from-gmail-mirror] sidecar unreachable (${(err as Error).message}); falling back to review-only`,
      );
    }
  } else {
    console.log(
      `[seed-from-gmail-mirror] SIDECAR_DATABASE_URL not set — every uncertain sender will seed as action='review'`,
    );
  }

  const counts: Record<
    SenderAction | "skipped_existing" | "skipped_invalid",
    number
  > = {
    auto_trash: 0,
    auto_archive: 0,
    always_keep: 0,
    review: 0,
    skipped_existing: 0,
    skipped_invalid: 0,
  };

  let processed = 0;

  for (const row of rows) {
    const canonical = canonicalizeSender(row.fromAddress);
    if (!canonical || !extractDomainFromEmailSafe(canonical)) {
      counts.skipped_invalid++;
      continue;
    }

    // Never overwrite existing rows.
    const existing = await prisma.senderDecision.findUnique({
      where: {
        emailAccountId_senderEmail: {
          emailAccountId,
          senderEmail: canonical,
        },
      },
      select: { id: true },
    });
    if (existing) {
      counts.skipped_existing++;
      continue;
    }

    const truth = sidecarMap.get(canonical) ?? null;
    const action: SenderAction = truth ? mapSidecarAction(truth) : "review";
    counts[action]++;

    if (!opts.apply) {
      processed++;
      continue;
    }

    await changeSenderDecision({
      emailAccountId,
      senderEmail: canonical,
      action,
      decisionSource: "seed",
      actor: "seed",
      auditSource: "script:seed-from-gmail-mirror",
      reason: truth
        ? `gmail-mirror volume=${row.messageCount}, sidecar(category=${truth.category ?? "?"},action=${truth.action ?? "?"})`
        : `gmail-mirror volume=${row.messageCount}, no sidecar match → review`,
      note: `seed from gmail-mirror (messageCount=${row.messageCount})`,
      firstSeenAt: epochToDate(row.firstSeenEpoch),
      lastSeenAt: epochToDate(row.lastSeenEpoch),
      messageCount: row.messageCount,
    });

    processed++;
    if (processed % 100 === 0) {
      console.log(
        `[seed-from-gmail-mirror] progress ${processed}/${rows.length}`,
      );
    }
  }

  console.log(
    `[seed-from-gmail-mirror] done mode=${opts.apply ? "APPLY" : "DRY-RUN"} processed=${processed}`,
  );
  console.log("[seed-from-gmail-mirror] breakdown:", counts);
  if (!opts.apply) {
    console.log(
      "[seed-from-gmail-mirror] re-run with --apply to persist changes.",
    );
  }
}

main()
  .catch((err) => {
    console.error("[seed-from-gmail-mirror] FAILED:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
