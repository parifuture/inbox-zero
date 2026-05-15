/**
 * EL-426 — Re-categorize Newsletter rows that are stalled with
 * `patternAnalyzed=true` AND `categoryId=NULL`.
 *
 * Root cause (documented in EL-426): the pattern-analyzer endpoint
 * (`/api/ai/analyze-sender-pattern`) and the auto-categorization flow are
 * independent. When pattern analysis writes a brand-new Newsletter row via
 * `savePatternCheck`, it sets `patternAnalyzed=true` but never sets
 * `categoryId`. The auto-categorization flow (`categorizeSender` in the
 * Gmail webhook) only runs when a NEW message arrives from that sender —
 * so any sender that went through pattern analysis once and didn't
 * receive another message stays stalled forever.
 *
 * This script finds the stalled rows and re-runs `categorizeSender` for
 * each. It's dry-run by default.
 *
 * Usage (from apps/web, with env sourced so NEXT_PUBLIC_BASE_URL etc. are set):
 *
 *   # dry-run, top 20 (the default) — show what categories would be
 *   # assigned without writing:
 *   NODE_OPTIONS="--require ./scripts/_stub-server-only.cjs" \
 *     pnpm tsx scripts/recategorize-stalled.ts --email pari.future@gmail.com
 *
 *   # dry-run, all 239:
 *   NODE_OPTIONS="--require ./scripts/_stub-server-only.cjs" \
 *     pnpm tsx scripts/recategorize-stalled.ts --email pari.future@gmail.com --limit 1000
 *
 *   # apply for real:
 *   NODE_OPTIONS="--require ./scripts/_stub-server-only.cjs" \
 *     pnpm tsx scripts/recategorize-stalled.ts --email pari.future@gmail.com --limit 1000 --apply
 *
 * The `--require` pre-hook stubs the `server-only` module so standalone
 * scripts can import server-tagged Next.js modules.
 *
 * Idempotent — reruns are safe. Rows that already have a `categoryId` are
 * skipped because the query filters on `categoryId IS NULL`.
 *
 * NO Gmail mutations. ONLY writes to Newsletter.categoryId (and creates
 * Category rows if the AI invents a new category — same behavior as the
 * live auto-categorize path).
 */

import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import {
  categorizeWithAi,
  updateSenderCategory,
} from "@/utils/categorize/senders/categorize";
import { getUserCategories } from "@/utils/category.server";
import { createEmailProvider } from "@/utils/email/provider";
import { validateUserAndAiAccess } from "@/utils/user/validate";
import { UNKNOWN_CATEGORY } from "@/utils/ai/categorize-sender/ai-categorize-senders";

const logger = createScopedLogger("recategorize-stalled");

type Args = {
  emailArg?: string;
  accountId?: string;
  limit: number;
  apply: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { limit: 20, apply: false };
  while (args.length) {
    const a = args.shift();
    if (a === "--email") out.emailArg = args.shift();
    else if (a === "--account-id") out.accountId = args.shift();
    else if (a === "--limit") out.limit = Number(args.shift() || "20");
    else if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.apply = false;
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
    throw new Error("Must supply --account-id or --email");
  }
  const acc = await prisma.emailAccount.findUnique({
    where: { email: emailArg.toLowerCase() },
    select: { id: true },
  });
  if (!acc) throw new Error(`No EmailAccount for ${emailArg}`);
  return acc.id;
}

async function main() {
  const { emailArg, accountId, limit, apply } = parseArgs();
  const emailAccountId = await resolveEmailAccountId({ emailArg, accountId });

  console.log(
    `[recategorize-stalled] EmailAccount=${emailAccountId} limit=${limit} apply=${apply}`,
  );

  // Total stalled count (before)
  const beforeCount = await prisma.newsletter.count({
    where: {
      emailAccountId,
      categoryId: null,
      patternAnalyzed: true,
    },
  });
  console.log(`[recategorize-stalled] stalled rows before: ${beforeCount}`);

  // Pull the stalled rows to work on
  const stalled = await prisma.newsletter.findMany({
    where: {
      emailAccountId,
      categoryId: null,
      patternAnalyzed: true,
    },
    orderBy: { lastAnalyzedAt: "desc" },
    take: limit,
    select: { email: true, name: true },
  });

  if (stalled.length === 0) {
    console.log("[recategorize-stalled] nothing to do");
    return;
  }

  // Validate AI access + load categories + provider once.
  const { emailAccount: validatedAccount } = await validateUserAndAiAccess({
    emailAccountId,
  });
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { account: { select: { provider: true } } },
  });
  if (!account?.account?.provider) {
    throw new Error("No email provider for account");
  }

  const emailAccountWithAi = {
    ...validatedAccount,
    account: { provider: account.account.provider },
  };

  const categories = await getUserCategories({ emailAccountId });
  if (categories.length === 0) {
    throw new Error("No categories configured for this account");
  }

  const provider = await createEmailProvider({
    emailAccountId,
    provider: account.account.provider,
    logger,
  });

  const results: Array<{
    email: string;
    assignedCategoryId?: string;
    assignedCategoryName?: string;
    error?: string;
  }> = [];

  // Build the sendersWithEmails map for the bulk-categorize path. The bulk
  // path uses the ECONOMY tier (Bedrock Haiku) which produces valid JSON,
  // unlike `categorizeSender`/`aiCategorizeSender` which currently uses the
  // DEFAULT provider (sidecar heuristic) and fails schema validation.
  const BATCH_SIZE = 10;
  for (let i = 0; i < stalled.length; i += BATCH_SIZE) {
    const batch = stalled.slice(i, i + BATCH_SIZE);
    console.log(
      `\n[batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
        stalled.length / BATCH_SIZE,
      )}] ${batch.length} senders${apply ? "" : " (dry-run)"}`,
    );

    const sendersWithEmails = new Map<
      string,
      { subject: string; snippet: string }[]
    >();
    for (const row of batch) {
      try {
        const threads = await provider.getThreadsFromSenderWithSubject(
          row.email,
          3,
        );
        sendersWithEmails.set(row.email, threads);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({ email: row.email, error: `fetch: ${msg}` });
        console.error(`  ${row.email} ✗ fetch error: ${msg}`);
      }
    }

    let aiResults: Array<{ sender: string; category?: string }> = [];
    try {
      aiResults = await categorizeWithAi({
        emailAccount: emailAccountWithAi,
        sendersWithEmails,
        categories,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  batch ai error: ${msg}`);
      for (const row of batch) {
        if (sendersWithEmails.has(row.email)) {
          results.push({ email: row.email, error: `ai: ${msg}` });
        }
      }
      continue;
    }

    for (const r of aiResults) {
      const row = batch.find((b) => b.email === r.sender);
      const assignedCategoryName = r.category ?? UNKNOWN_CATEGORY;
      const assignedCategoryId = categories.find(
        (c) => c.name === assignedCategoryName,
      )?.id;

      if (!apply) {
        results.push({
          email: r.sender,
          assignedCategoryId,
          assignedCategoryName,
        });
        console.log(`  ${r.sender} → would assign "${assignedCategoryName}"`);
        continue;
      }

      try {
        await updateSenderCategory({
          sender: r.sender,
          senderName: row?.name ?? undefined,
          categories,
          categoryName: assignedCategoryName,
          emailAccountId,
        });
        // Re-read to get the actually-assigned categoryId (handles the case
        // where updateSenderCategory created a new Category row).
        const saved = await prisma.newsletter.findUnique({
          where: {
            email_emailAccountId: {
              email: r.sender,
              emailAccountId,
            },
          },
          select: { categoryId: true },
        });
        results.push({
          email: r.sender,
          assignedCategoryId: saved?.categoryId ?? undefined,
          assignedCategoryName,
        });
        console.log(
          `  ${r.sender} → assigned "${assignedCategoryName}" (id=${saved?.categoryId ?? "?"})`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({ email: r.sender, error: `write: ${msg}` });
        console.error(`  ${r.sender} ✗ write error: ${msg}`);
      }
    }

    // Anything in the batch that got no AI result at all
    for (const row of batch) {
      if (
        !results.find((r) => r.email === row.email) &&
        sendersWithEmails.has(row.email)
      ) {
        results.push({ email: row.email, error: "no ai result" });
        console.error(`  ${row.email} ✗ no ai result`);
      }
    }
  }

  // Summary
  const errored = results.filter((r) => r.error).length;
  const categorized = results.filter((r) => r.assignedCategoryId).length;
  const uncategorized = results.filter(
    (r) => !r.error && !r.assignedCategoryId,
  ).length;

  console.log("\n[recategorize-stalled] summary");
  console.log(`  processed:    ${results.length}`);
  console.log(`  categorized:  ${categorized}`);
  console.log(`  uncategorized:${uncategorized}`);
  console.log(`  errors:       ${errored}`);

  // Category distribution of what was assigned
  const dist = new Map<string, number>();
  for (const r of results) {
    if (!r.assignedCategoryName) continue;
    dist.set(
      r.assignedCategoryName,
      (dist.get(r.assignedCategoryName) ?? 0) + 1,
    );
  }
  if (dist.size > 0) {
    console.log("\n  distribution:");
    for (const [name, count] of [...dist.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`    ${name}: ${count}`);
    }
  }

  if (apply) {
    const afterCount = await prisma.newsletter.count({
      where: {
        emailAccountId,
        categoryId: null,
        patternAnalyzed: true,
      },
    });
    console.log(
      `\n[recategorize-stalled] stalled rows after: ${afterCount} (was ${beforeCount})`,
    );
  } else {
    console.log(
      "\n[recategorize-stalled] DRY RUN — no writes. Re-run with --apply to commit.",
    );
  }
}

main()
  .catch((err) => {
    console.error("[recategorize-stalled] FAILED:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
