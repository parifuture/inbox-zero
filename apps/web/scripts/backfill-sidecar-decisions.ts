/**
 * EL-363 — Backfill `ParityDecision.sidecarAction` + `sidecarRuleName` from
 * the sidecar's `spam_decisions` table.
 *
 * The sidecar remains the source of truth until the fork's shadow classifier
 * is verified in parity. The parity harness (EL-363) needs both sides on the
 * same row to compute agreement; EL-358b wires the fork side, this script
 * wires the sidecar side.
 *
 * Run:
 *
 *   SIDECAR_DATABASE_URL="postgres://..." \
 *   pnpm tsx scripts/backfill-sidecar-decisions.ts
 *
 * Optional flags:
 *   --since 2026-05-01          only backfill ParityDecision rows newer than this
 *   --email-account <cuid>      restrict to a single account
 *   --batch 500                 sidecar-side fetch batch size (default 500)
 *   --dry-run                   log counts but don't write
 *
 * Idempotent: re-running is safe; we only update rows where the sidecar
 * columns are still null OR differ from the sidecar's current value.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
import { Client as PgClient } from "pg";
import prisma from "@/utils/prisma";

interface Args {
  batch: number;
  dryRun: boolean;
  emailAccountId?: string;
  since?: Date;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { batch: 500, dryRun: false };
  while (argv.length) {
    const a = argv.shift();
    if (a === "--since") {
      const raw = argv.shift();
      if (raw) out.since = new Date(raw);
    } else if (a === "--email-account") {
      out.emailAccountId = argv.shift();
    } else if (a === "--batch") {
      const raw = argv.shift();
      const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
      if (Number.isFinite(n) && n > 0) out.batch = n;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    }
  }
  return out;
}

interface SidecarRow {
  action: string;
  message_id: string;
  rule_name: string | null;
  stage_decided: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const sidecarUrl = process.env.SIDECAR_DATABASE_URL;
  if (!sidecarUrl) {
    console.error(
      "[backfill-sidecar-decisions] SIDECAR_DATABASE_URL is required.",
    );
    process.exit(1);
  }

  // 1. Pull candidate ParityDecision rows — the ones we need to fill.
  const forkRows = await prisma.parityDecision.findMany({
    where: {
      ...(args.emailAccountId ? { emailAccountId: args.emailAccountId } : {}),
      ...(args.since ? { createdAt: { gte: args.since } } : {}),
    },
    select: {
      id: true,
      messageId: true,
      sidecarAction: true,
      sidecarRuleName: true,
    },
  });

  if (forkRows.length === 0) {
    console.log("[backfill-sidecar-decisions] No ParityDecision rows match.");
    return;
  }

  console.log(
    `[backfill-sidecar-decisions] Found ${forkRows.length} fork rows to consider.`,
  );

  // 2. Connect to the sidecar DB and fetch matching spam_decisions rows.
  const sidecar = new PgClient({ connectionString: sidecarUrl });
  await sidecar.connect();

  const byMessageId = new Map<string, SidecarRow>();
  try {
    for (let i = 0; i < forkRows.length; i += args.batch) {
      const slice = forkRows.slice(i, i + args.batch);
      const ids = slice.map((r) => r.messageId);
      const res = await sidecar.query<SidecarRow>(
        `SELECT DISTINCT ON (message_id)
                message_id, action, rule_name, stage_decided
           FROM spam_decisions
          WHERE message_id = ANY($1::text[])
          ORDER BY message_id, created_at DESC`,
        [ids],
      );
      for (const row of res.rows) {
        byMessageId.set(row.message_id, row);
      }
    }
  } finally {
    await sidecar.end();
  }

  console.log(
    `[backfill-sidecar-decisions] Matched ${byMessageId.size} sidecar rows.`,
  );

  // 3. Diff and update. Only write rows where the stored sidecar columns
  //    are missing or stale relative to the sidecar's current value.
  let toWrite = 0;
  let skipped = 0;
  const updates: Array<{
    id: string;
    action: string;
    ruleName: string | null;
  }> = [];
  for (const fork of forkRows) {
    const sc = byMessageId.get(fork.messageId);
    if (!sc) continue;
    if (
      fork.sidecarAction === sc.action &&
      (fork.sidecarRuleName ?? null) === (sc.rule_name ?? null)
    ) {
      skipped += 1;
      continue;
    }
    toWrite += 1;
    updates.push({ id: fork.id, action: sc.action, ruleName: sc.rule_name });
  }

  console.log(
    `[backfill-sidecar-decisions] ${toWrite} rows need update, ${skipped} already current, ${
      forkRows.length - byMessageId.size
    } unmatched (sidecar never saw them).`,
  );

  if (args.dryRun) {
    console.log("[backfill-sidecar-decisions] --dry-run; not writing.");
    return;
  }

  // Batched updates — one transaction per 500 for progress granularity.
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await prisma.$transaction(
      chunk.map((u) =>
        prisma.parityDecision.update({
          where: { id: u.id },
          data: { sidecarAction: u.action, sidecarRuleName: u.ruleName },
        }),
      ),
    );
    console.log(
      `[backfill-sidecar-decisions] wrote ${Math.min(i + CHUNK, updates.length)}/${updates.length}`,
    );
  }

  console.log("[backfill-sidecar-decisions] Done.");
}

main()
  .catch((err) => {
    console.error("[backfill-sidecar-decisions] Failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
