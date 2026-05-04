/**
 * EL-354 — Seed the forked Inbox Zero `SenderDecision` table from the legacy
 * sidecar's `sender_truth` table.
 *
 * Run:
 *
 *   SIDECAR_DATABASE_URL="postgres://..." \
 *   TARGET_EMAIL_ACCOUNT_ID="<cuid>" \
 *   pnpm tsx scripts/seed-sender-decision.ts
 *
 * Or via `--email pari.future@gmail.com` to resolve the account id:
 *
 *   pnpm tsx scripts/seed-sender-decision.ts --email pari.future@gmail.com
 *
 * Idempotent:
 *  - Re-running refreshes `messageCount` / `firstSeenAt` / `lastSeenAt` from
 *    the local `EmailMessage` table.
 *  - Rows whose `source === "user"` are NEVER overwritten by this seeder.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- `pg` is a runtime dep; @types/pg is transitive-only.
import { Client as PgClient } from "pg";
import prisma from "@/utils/prisma";
import { canonicalizeSender, upsertDecision } from "@/utils/sender-decision";
import type { SenderAction } from "@/generated/prisma/enums";

type SidecarRow = {
  sender_email: string;
  category: string | null;
  action: string | null;
  confidence: number | null;
  source: string | null;
};

function mapSidecarAction(row: SidecarRow): SenderAction {
  const action = (row.action ?? "").toLowerCase();
  const category = (row.category ?? "").toLowerCase();

  // Explicit trash first.
  if (action === "trash") return "auto_trash";

  // Marketing / bulk → auto_trash.
  if (
    category === "bulk" ||
    category === "marketing" ||
    category === "promotional"
  ) {
    return "auto_trash";
  }

  // Transactional / receipts / sent-history / inbox → always_keep.
  if (
    category === "transactional" ||
    category === "receipts" ||
    category === "sent-history" ||
    action === "archive" ||
    action === "inbox" ||
    action === "keep"
  ) {
    return "always_keep";
  }

  return "review";
}

function parseArgs(): { emailArg?: string; accountId?: string } {
  const args = process.argv.slice(2);
  const out: { emailArg?: string; accountId?: string } = {};
  while (args.length) {
    const a = args.shift();
    if (a === "--email") out.emailArg = args.shift();
    else if (a === "--account-id") out.accountId = args.shift();
  }
  if (!out.accountId && process.env.TARGET_EMAIL_ACCOUNT_ID) {
    out.accountId = process.env.TARGET_EMAIL_ACCOUNT_ID;
  }
  if (!out.emailArg && process.env.TARGET_EMAIL) {
    out.emailArg = process.env.TARGET_EMAIL;
  }
  return out;
}

async function resolveEmailAccountId({
  emailArg,
  accountId,
}: {
  emailArg?: string;
  accountId?: string;
}): Promise<string> {
  if (accountId) return accountId;
  if (!emailArg) {
    throw new Error(
      "Must supply --account-id, --email, TARGET_EMAIL_ACCOUNT_ID, or TARGET_EMAIL",
    );
  }
  const acc = await prisma.emailAccount.findUnique({
    where: { email: emailArg.toLowerCase() },
    select: { id: true },
  });
  if (!acc) throw new Error(`No EmailAccount for ${emailArg}`);
  return acc.id;
}

async function fetchSidecarRows(sidecarUrl: string): Promise<SidecarRow[]> {
  const client = new PgClient({ connectionString: sidecarUrl });
  await client.connect();
  try {
    const res = await client.query<SidecarRow>(
      `SELECT sender_email, category, action, confidence, source
         FROM sender_truth`,
    );
    return res.rows;
  } finally {
    await client.end();
  }
}

async function computeVolumeStats(
  emailAccountId: string,
  senderEmail: string,
): Promise<{
  messageCount: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}> {
  const agg = await prisma.emailMessage.aggregate({
    where: { emailAccountId, from: { contains: senderEmail } },
    _count: { _all: true },
    _min: { date: true },
    _max: { date: true },
  });
  return {
    messageCount: agg._count._all,
    firstSeenAt: agg._min.date ?? null,
    lastSeenAt: agg._max.date ?? null,
  };
}

async function main() {
  const sidecarUrl = process.env.SIDECAR_DATABASE_URL;
  if (!sidecarUrl) {
    console.error(
      "[seed-sender-decision] SIDECAR_DATABASE_URL is required. " +
        "Example: postgres://sidecar:pw@localhost:5433/sidecar",
    );
    process.exit(1);
  }

  const { emailArg, accountId } = parseArgs();
  const emailAccountId = await resolveEmailAccountId({ emailArg, accountId });

  console.log(`[seed-sender-decision] Target EmailAccount: ${emailAccountId}`);

  const rows = await fetchSidecarRows(sidecarUrl);
  console.log(
    `[seed-sender-decision] Pulled ${rows.length} rows from sidecar sender_truth`,
  );

  let upserted = 0;
  let skipped = 0;
  const counts: Record<SenderAction, number> = {
    auto_trash: 0,
    auto_archive: 0,
    always_keep: 0,
    review: 0,
  };

  for (const row of rows) {
    const canonical = canonicalizeSender(row.sender_email);
    if (!canonical) {
      skipped++;
      continue;
    }

    const action = mapSidecarAction(row);
    counts[action]++;

    const stats = await computeVolumeStats(emailAccountId, canonical);

    await upsertDecision({
      emailAccountId,
      senderEmail: canonical,
      action,
      source: "seed",
      note: `seed from sidecar.sender_truth (category=${row.category ?? "?"}, action=${row.action ?? "?"}, src=${row.source ?? "?"})`,
      firstSeenAt: stats.firstSeenAt,
      lastSeenAt: stats.lastSeenAt,
      messageCount: stats.messageCount,
      protectUserDecisions: true,
    });
    upserted++;

    if (upserted % 100 === 0) {
      console.log(`[seed-sender-decision] progress ${upserted}/${rows.length}`);
    }
  }

  console.log(
    `[seed-sender-decision] done. upserted=${upserted} skipped=${skipped}`,
  );
  console.log("[seed-sender-decision] action breakdown:", counts);
}

main()
  .catch((err) => {
    console.error("[seed-sender-decision] FAILED:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
