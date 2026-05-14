/**
 * EL-427 — Benchmark the deterministic pre-classifier against Bedrock-assigned categories.
 *
 * READ-ONLY. Does NOT write to Postgres or to gmail-mirror.
 *
 * Pulls every Newsletter row with a non-null categoryId for the target
 * EmailAccount, looks up that sender's recent subjects in the local
 * gmail-mirror SQLite, runs `preClassify(...)`, and compares the
 * pre-classifier output against the existing (Bedrock-assigned) category.
 *
 * Outputs (markdown, stdout):
 *   - Population stats
 *   - Hit rate (confidence >= threshold AND category in user taxonomy)
 *   - Per-category agreement (when pre-classifier hits)
 *   - Confusion matrix
 *   - Sample misses for tuning
 *
 * Usage:
 *   pnpm tsx scripts/benchmark-pre-classifier.ts \
 *     --email-account pari.future@gmail.com
 *
 *   # Override the gmail-mirror DB path:
 *   pnpm tsx scripts/benchmark-pre-classifier.ts \
 *     --email-account pari.future@gmail.com \
 *     --db ~/data/gmail-mirror/benchmark-source.db
 *
 *   # Limit subjects pulled per sender (default 5):
 *   pnpm tsx scripts/benchmark-pre-classifier.ts \
 *     --email-account pari.future@gmail.com --subjects-per-sender 5
 *
 *   # Only show senders where pre-classifier disagreed with Bedrock:
 *   pnpm tsx scripts/benchmark-pre-classifier.ts \
 *     --email-account pari.future@gmail.com --show-misses
 */

import { DatabaseSync } from "node:sqlite";
import * as os from "node:os";
import * as path from "node:path";
import prisma from "@/utils/prisma";
import { extractDomainFromEmail, extractEmailAddress } from "@/utils/email";
import {
  PRE_CLASSIFIER_CONFIDENCE_THRESHOLD,
  preClassify,
} from "@/utils/ai/categorize-senders/pre-classifier";
import { parseArgs } from "./seed-from-gmail-mirror.lib";

const DEFAULT_DB =
  process.env.GMAIL_MIRROR_DB ||
  path.join(os.homedir(), "code/gmail-mirror/gmail-mirror.db");

type Opts = {
  dbPath: string;
  emailAccount?: string;
  accountId?: string;
  subjectsPerSender: number;
  showMisses: boolean;
  threshold: number;
};

function parseCliOpts(argv: string[]): Opts {
  const parsed = parseArgs(argv, {
    string: ["db", "email-account", "account-id"],
    number: ["subjects-per-sender", "threshold"],
    boolean: ["show-misses"],
  });
  return {
    dbPath: (parsed.db as string) || DEFAULT_DB,
    emailAccount: parsed["email-account"] as string | undefined,
    accountId: parsed["account-id"] as string | undefined,
    subjectsPerSender: (parsed["subjects-per-sender"] as number) || 5,
    showMisses: parsed["show-misses"] === true,
    threshold:
      (parsed.threshold as number) || PRE_CLASSIFIER_CONFIDENCE_THRESHOLD,
  };
}

async function resolveEmailAccountId(opts: Opts): Promise<{
  id: string;
  email: string;
}> {
  if (opts.accountId) {
    const acc = await prisma.emailAccount.findUnique({
      where: { id: opts.accountId },
      select: { id: true, email: true },
    });
    if (!acc) throw new Error(`No EmailAccount with id=${opts.accountId}`);
    return acc;
  }
  if (!opts.emailAccount) {
    throw new Error(
      "Must supply --account-id <cuid> or --email-account <email>.",
    );
  }
  const acc = await prisma.emailAccount.findUnique({
    where: { email: opts.emailAccount.toLowerCase() },
    select: { id: true, email: true },
  });
  if (!acc) {
    throw new Error(`No EmailAccount for ${opts.emailAccount}`);
  }
  return acc;
}

type LabeledSender = {
  email: string;
  truthCategory: string;
};

async function loadLabeledSenders(
  emailAccountId: string,
): Promise<LabeledSender[]> {
  // Newsletter row holds the per-sender category assignment (Bedrock-assigned).
  const rows = await prisma.newsletter.findMany({
    where: {
      emailAccountId,
      categoryId: { not: null },
    },
    select: {
      email: true,
      category: { select: { name: true } },
    },
  });
  return rows
    .filter((r) => r.category?.name)
    .map((r) => ({
      email: r.email,
      truthCategory: r.category!.name,
    }));
}

function getLocalPart(email: string): string {
  const addr = extractEmailAddress(email) || email;
  const at = addr.indexOf("@");
  return at >= 0 ? addr.slice(0, at) : addr;
}

function getRecentSubjects(
  db: DatabaseSync,
  fromAddress: string,
  limit: number,
): string[] {
  // gmail-mirror stores `from_address` as `Display Name <email@domain>`
  // sometimes, sometimes just `email@domain`. We match both ways: exact, and
  // contains the canonical lowercased email.
  const target = (
    extractEmailAddress(fromAddress) || fromAddress
  ).toLowerCase();
  const stmt = db.prepare(
    `SELECT subject FROM emails
     WHERE LOWER(from_address) = ?
        OR LOWER(from_address) LIKE ?
     ORDER BY date_sent DESC
     LIMIT ?`,
  );
  const rows = stmt.all(target, `%<${target}>%`, limit) as {
    subject: string | null;
  }[];
  return rows.map((r) => r.subject ?? "").filter(Boolean);
}

type Sample = {
  sender: string;
  truth: string;
  predicted: string | null;
  confidence: number;
  hit: boolean; // confidence >= threshold and predicted not null
  agree: boolean | null; // truth === predicted (only meaningful when hit)
  subjectCount: number;
};

function tally(
  samples: Sample[],
  _threshold: number,
): {
  total: number;
  hit: number;
  miss: number;
  hitRate: number;
  perCategory: Map<
    string,
    { hits: number; agree: number; total: number; coverage: number }
  >;
  confusion: Map<string, Map<string, number>>; // truth -> predicted -> count
} {
  const total = samples.length;
  const hits = samples.filter((s) => s.hit);
  const hit = hits.length;
  const miss = total - hit;

  const perCategory = new Map<
    string,
    { hits: number; agree: number; total: number; coverage: number }
  >();
  const truthCounts = new Map<string, number>();
  for (const s of samples) {
    truthCounts.set(s.truth, (truthCounts.get(s.truth) ?? 0) + 1);
  }
  for (const [cat, n] of truthCounts) {
    const catHits = hits.filter((h) => h.truth === cat);
    const agree = catHits.filter((h) => h.agree).length;
    perCategory.set(cat, {
      total: n,
      hits: catHits.length,
      agree,
      coverage: n === 0 ? 0 : catHits.length / n,
    });
  }

  const confusion = new Map<string, Map<string, number>>();
  for (const h of hits) {
    if (!h.predicted) continue;
    const inner = confusion.get(h.truth) ?? new Map<string, number>();
    inner.set(h.predicted, (inner.get(h.predicted) ?? 0) + 1);
    confusion.set(h.truth, inner);
  }

  return {
    total,
    hit,
    miss,
    hitRate: total === 0 ? 0 : hit / total,
    perCategory,
    confusion,
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function renderMarkdown(
  emailAccount: string,
  threshold: number,
  subjectsPerSender: number,
  samples: Sample[],
  stats: ReturnType<typeof tally>,
  showMisses: boolean,
): string {
  const lines: string[] = [];
  lines.push("# Pre-classifier Benchmark Report (EL-427)");
  lines.push("");
  lines.push(`- **Email account:** \`${emailAccount}\``);
  lines.push(`- **Confidence threshold:** \`${threshold}\``);
  lines.push(`- **Subjects per sender:** \`${subjectsPerSender}\``);
  lines.push(`- **Generated:** \`${new Date().toISOString()}\``);
  lines.push("");
  lines.push("## Population");
  lines.push("");
  lines.push(`- Total labeled senders: **${stats.total}**`);
  const withSubjects = samples.filter((s) => s.subjectCount > 0).length;
  lines.push(
    `- Senders with >=1 subject in gmail-mirror: **${withSubjects}** (${
      stats.total === 0 ? "0%" : fmtPct(withSubjects / stats.total)
    })`,
  );
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push(
    `- **Hit rate (confidence >= ${threshold}):** ${stats.hit}/${stats.total} = **${fmtPct(
      stats.hitRate,
    )}**`,
  );
  // Headline newsletter / marketing agreement when present.
  const nl = stats.perCategory.get("Newsletter");
  const mk = stats.perCategory.get("Marketing");
  if (nl && nl.hits > 0) {
    lines.push(
      `- **Newsletter agreement (when hit):** ${nl.agree}/${nl.hits} = **${fmtPct(
        nl.agree / nl.hits,
      )}**`,
    );
  }
  if (mk && mk.hits > 0) {
    lines.push(
      `- **Marketing agreement (when hit):** ${mk.agree}/${mk.hits} = **${fmtPct(
        mk.agree / mk.hits,
      )}**`,
    );
  }
  lines.push("");
  lines.push("## Per-category breakdown");
  lines.push("");
  lines.push(
    "| Truth category | Population | Pre-classifier hits | Coverage | Hit-then-agree |",
  );
  lines.push("|---|---:|---:|---:|---:|");
  const cats = Array.from(stats.perCategory.keys()).sort();
  for (const cat of cats) {
    const r = stats.perCategory.get(cat)!;
    const agreeStr =
      r.hits === 0 ? "—" : `${r.agree}/${r.hits} (${fmtPct(r.agree / r.hits)})`;
    lines.push(
      `| ${cat} | ${r.total} | ${r.hits} | ${fmtPct(r.coverage)} | ${agreeStr} |`,
    );
  }
  lines.push("");
  lines.push("## Confusion matrix (only counts hits)");
  lines.push("");
  // Build axis: union of truth categories and predicted categories that we saw.
  const truthCats = new Set<string>();
  const predCats = new Set<string>();
  for (const [t, inner] of stats.confusion) {
    truthCats.add(t);
    for (const p of inner.keys()) predCats.add(p);
  }
  const truthList = Array.from(truthCats).sort();
  const predList = Array.from(predCats).sort();
  if (truthList.length === 0 || predList.length === 0) {
    lines.push("_No pre-classifier hits — nothing to plot._");
  } else {
    lines.push(`| Truth \\ Predicted | ${predList.join(" | ")} | total |`);
    lines.push(`|---|${predList.map(() => "---:").join("|")}|---:|`);
    for (const t of truthList) {
      const inner = stats.confusion.get(t) ?? new Map<string, number>();
      const cells = predList.map((p) => String(inner.get(p) ?? 0));
      const total = Array.from(inner.values()).reduce((a, b) => a + b, 0);
      lines.push(`| ${t} | ${cells.join(" | ")} | ${total} |`);
    }
  }
  lines.push("");
  if (showMisses) {
    lines.push("## Sample disagreements (truth != predicted, hit)");
    lines.push("");
    const disagreements = samples
      .filter((s) => s.hit && s.predicted && s.predicted !== s.truth)
      .slice(0, 25);
    if (disagreements.length === 0) {
      lines.push("_None._");
    } else {
      lines.push("| Sender | Truth | Predicted | Confidence | Subjects |");
      lines.push("|---|---|---|---:|---:|");
      for (const s of disagreements) {
        lines.push(
          `| \`${s.sender}\` | ${s.truth} | ${s.predicted} | ${s.confidence.toFixed(
            2,
          )} | ${s.subjectCount} |`,
        );
      }
    }
    lines.push("");
    lines.push("## Sample below-threshold senders");
    lines.push("");
    const belowThreshold = samples
      .filter((s) => !s.hit && s.subjectCount > 0)
      .slice(0, 25);
    if (belowThreshold.length === 0) {
      lines.push("_None._");
    } else {
      lines.push(
        "| Sender | Truth | Predicted (best) | Confidence | Subjects |",
      );
      lines.push("|---|---|---|---:|---:|");
      for (const s of belowThreshold) {
        lines.push(
          `| \`${s.sender}\` | ${s.truth} | ${s.predicted ?? "—"} | ${s.confidence.toFixed(
            2,
          )} | ${s.subjectCount} |`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## Targets");
  lines.push("");
  lines.push("| Metric | Target | Actual | Pass? |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| Hit rate (confidence >= ${threshold}) | >= 40% | ${fmtPct(
      stats.hitRate,
    )} | ${stats.hitRate >= 0.4 ? "✅" : "❌"} |`,
  );
  if (nl && nl.hits > 0) {
    const r = nl.agree / nl.hits;
    lines.push(
      `| Newsletter agreement | >= 80% | ${fmtPct(r)} | ${r >= 0.8 ? "✅" : "❌"} |`,
    );
  } else {
    lines.push("| Newsletter agreement | >= 80% | — (no hits) | ❌ |");
  }
  if (mk && mk.hits > 0) {
    const r = mk.agree / mk.hits;
    lines.push(
      `| Marketing agreement | >= 80% | ${fmtPct(r)} | ${r >= 0.8 ? "✅" : "❌"} |`,
    );
  } else {
    lines.push("| Marketing agreement | >= 80% | — (no hits) | ❌ |");
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const opts = parseCliOpts(process.argv.slice(2));
  const acc = await resolveEmailAccountId(opts);

  const labeled = await loadLabeledSenders(acc.id);
  if (labeled.length === 0) {
    console.error("No labeled Newsletter rows found. Nothing to benchmark.");
    process.exit(2);
  }

  const db = new DatabaseSync(opts.dbPath, { readOnly: true });

  const samples: Sample[] = [];
  for (const row of labeled) {
    const recentSubjects = getRecentSubjects(
      db,
      row.email,
      opts.subjectsPerSender,
    );
    const senderLocalPart = getLocalPart(row.email);
    const senderDomain = extractDomainFromEmail(row.email);
    const result = preClassify({
      senderLocalPart,
      senderDomain,
      recentSubjects,
    });

    const hit = !!result.category && result.confidence >= opts.threshold;

    samples.push({
      sender: row.email,
      truth: row.truthCategory,
      predicted: result.category,
      confidence: result.confidence,
      hit,
      agree: hit ? result.category === row.truthCategory : null,
      subjectCount: recentSubjects.length,
    });
  }

  db.close();
  await prisma.$disconnect();

  const stats = tally(samples, opts.threshold);
  const md = renderMarkdown(
    acc.email,
    opts.threshold,
    opts.subjectsPerSender,
    samples,
    stats,
    opts.showMisses,
  );
  process.stdout.write(`${md}\n`);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
