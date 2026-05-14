/**
 * EL-432 smoke test — runs the exclusion classifier against the live
 * sender_truth + vip_senders + sender_aggregates rows in Postgres and
 * prints a breakdown by reason.
 *
 * Usage (from a host shell):
 *   pnpm tsx apps/web/scripts/smoke-sent-history.ts
 *
 * Connects via DATABASE_URL (override via env if needed).
 */

import { Pool } from "pg";
import { classifyExclusion } from "../utils/sent-history/exclusion-rules";
import { extractDomainFromEmail } from "../utils/email";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/inboxzero";

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const truth = await pool.query<{
    sender_email: string;
    evidence: { last_sent?: string | null; sent_count?: number | null } | null;
  }>(`SELECT sender_email, evidence FROM sender_truth WHERE action='archive'`);
  const senderEmails = truth.rows.map((r) => r.sender_email.toLowerCase());

  const aggregates =
    senderEmails.length === 0
      ? {
          rows: [] as {
            address: string;
            last_received: string | null;
            total_received_from: number | null;
          }[],
        }
      : await pool.query<{
          address: string;
          last_received: string | null;
          total_received_from: number | null;
        }>(
          "SELECT address, last_received, total_received_from FROM sender_aggregates WHERE address = ANY($1::text[])",
          [senderEmails],
        );

  const aggMap = new Map(
    aggregates.rows.map((a) => [a.address.toLowerCase(), a]),
  );

  const vips = await pool.query<{
    address: string | null;
    domain: string | null;
  }>("SELECT address, domain FROM vip_senders");
  const vipAddresses = new Set(
    vips.rows.map((v) => v.address?.toLowerCase()).filter(Boolean) as string[],
  );
  const vipDomains = new Set(
    vips.rows.map((v) => v.domain?.toLowerCase()).filter(Boolean) as string[],
  );

  const reasons: Record<string, number> = {};
  const examples: Record<string, string[]> = {};
  let willArchive = 0;
  let totalReceived = 0;

  for (const r of truth.rows) {
    const senderEmail = r.sender_email.toLowerCase();
    const senderDomain = extractDomainFromEmail(senderEmail);
    const agg = aggMap.get(senderEmail);
    const isVip =
      vipAddresses.has(senderEmail) ||
      (!!senderDomain && vipDomains.has(senderDomain));
    const reason = classifyExclusion({
      senderEmail,
      senderDomain,
      isVip,
      lastReceivedAt: agg?.last_received ?? null,
      lastSentAt: r.evidence?.last_sent ?? null,
    });
    if (reason) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      if (!examples[reason]) examples[reason] = [];
      if (examples[reason].length < 3) examples[reason].push(senderEmail);
    } else {
      willArchive += 1;
      totalReceived += agg?.total_received_from ?? 0;
    }
  }

  console.log("EL-432 sent-history bulk-archive — smoke test");
  console.log("============================================");
  console.log(`candidates total : ${truth.rows.length}`);
  console.log(`will archive     : ${willArchive}`);
  console.log(
    `~messages saved  : ${totalReceived.toLocaleString()} (sum of total_received_from for archive set)`,
  );
  console.log("");
  console.log("Excluded by reason:");
  for (const [reason, count] of Object.entries(reasons).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${reason.padEnd(18)} ${String(count).padStart(5)}`);
    for (const ex of examples[reason] ?? []) {
      console.log(`      e.g. ${ex}`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
