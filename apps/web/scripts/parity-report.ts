/**
 * EL-363 — parity agreement report.
 *
 * Pulls ParityDecision rows (optionally filtered) and prints:
 *   1. A human-readable summary to stdout.
 *   2. A single structured log line (`parity.agreement`) to stderr that is
 *      pipe-friendly for log aggregators.
 *
 * Run:
 *   pnpm tsx scripts/parity-report.ts [--days 7] [--email-account <cuid>]
 */

import prisma from "@/utils/prisma";
import { loadParityRows } from "@/utils/parity-classifier/load-parity-rows";
import {
  buildAgreementLogPayload,
  computeAgreementStats,
} from "@/utils/parity-classifier/metrics";

interface Args {
  days?: number;
  emailAccountId?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = {};
  while (argv.length) {
    const a = argv.shift();
    if (a === "--days") {
      const raw = argv.shift();
      const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
      if (Number.isFinite(n) && n > 0) out.days = n;
    } else if (a === "--email-account") {
      out.emailAccountId = argv.shift();
    }
  }
  return out;
}

function pct(n: number | null): string {
  if (n === null) return "n/a";
  return `${(n * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const since = args.days
    ? new Date(Date.now() - args.days * 24 * 60 * 60 * 1000)
    : undefined;

  const rows = await loadParityRows({
    emailAccountId: args.emailAccountId,
    since,
  });
  const stats = computeAgreementStats(rows);

  const heading = [
    "Parity agreement report",
    args.emailAccountId ? `account=${args.emailAccountId}` : "account=ALL",
    args.days ? `window=${args.days}d` : "window=ALL",
  ].join(" | ");

  console.log(heading);
  console.log("-".repeat(heading.length));
  console.log(`Total rows:      ${stats.total}`);
  console.log(
    `Compared rows:   ${stats.compared} (uncompared: ${stats.uncompared})`,
  );
  console.log(`Agreed rows:     ${stats.agreed}`);
  console.log(`Agreement rate:  ${pct(stats.agreementRate)}`);
  console.log("");
  console.log("Per-stage agreement:");
  for (const s of stats.stages) {
    console.log(
      `  stage ${s.stage}: ${s.agreed}/${s.compared} (${pct(s.agreementRate)}) — total ${s.total}`,
    );
  }
  if (stats.actionDrift.length > 0) {
    console.log("");
    console.log("Top action drift (fork -> sidecar):");
    for (const d of stats.actionDrift.slice(0, 10)) {
      console.log(
        `  ${d.forkAction.padEnd(8)} -> ${d.sidecarAction.padEnd(8)} x${d.count}`,
      );
    }
  }
  if (stats.ruleDrift.length > 0) {
    console.log("");
    console.log("Top rule-name drift (fork -> sidecar):");
    for (const d of stats.ruleDrift.slice(0, 10)) {
      console.log(
        `  ${(d.forkRuleName ?? "∅").padEnd(24)} -> ${(d.sidecarRuleName ?? "∅").padEnd(24)} x${d.count}`,
      );
    }
  }

  // Structured log line for aggregators (stderr to keep stdout clean).
  const payload = buildAgreementLogPayload(stats);
  process.stderr.write(
    `${JSON.stringify({
      ...payload,
      email_account_id: args.emailAccountId ?? null,
      window_days: args.days ?? null,
    })}\n`,
  );
}

main()
  .catch((err) => {
    console.error("[parity-report] Failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
