#!/usr/bin/env node
/**
 * EL-365: enforce that all SenderDecision writes go through
 * `changeSenderDecision` / `deleteSenderDecision` in
 * apps/web/utils/sender-decision/change.ts.
 *
 * Biome doesn't currently support custom AST-level `noRestrictedSyntax`
 * style guards, so this is a grep-based CI check that runs in the lint
 * step. It scans for calls like `prisma.senderDecision.update(...)` (or
 * `upsert|create|createMany|update|updateMany|delete|deleteMany`) outside
 * the allowlisted files in apps/web/utils/sender-decision/ and the
 * sender-decision API routes (which are the authors of the helpers) and
 * test fixtures.
 *
 * Run: `node scripts/check-sender-decision-writes.mjs`
 */
import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const webRoot = path.join(repoRoot, "apps", "web");

// Paths allowed to write SenderDecision directly. Only the helper itself
// (plus generated client + prisma migrations) may do so. Every route must
// call `changeSenderDecision` / `deleteSenderDecision`.
const ALLOW_PATHS = [
  path.join(webRoot, "utils", "sender-decision"),
  path.join(webRoot, "prisma"),
  path.join(webRoot, "generated"),
  path.join(webRoot, "scripts"),
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  ".vercel",
  ".git",
  "generated",
  "storybook-static",
  "coverage",
]);

const WRITE_PATTERN =
  /prisma\.senderDecision\s*\.\s*(update(Many)?|upsert|create(Many)?|delete(Many)?)\s*\(/g;

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walk(full)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      results.push(full);
    }
  }
  return results;
}

function isAllowed(filePath) {
  return ALLOW_PATHS.some((allow) => filePath.startsWith(`${allow}${path.sep}`));
}

const files = await walk(webRoot);
const violations = [];
const OPT_OUT = /@allow-direct-senderdecision-write/;
for (const file of files) {
  if (isAllowed(file)) continue;
  if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!text.includes("prisma.senderDecision.")) continue;
  const lines = text.split("\n");
  const matches = [...text.matchAll(WRITE_PATTERN)];
  if (matches.length === 0) continue;
  for (const m of matches) {
    const before = text.slice(0, m.index);
    const line = before.split("\n").length;
    // Allow opt-out on the call line or the preceding line.
    const prev = lines[line - 2] ?? "";
    const cur = lines[line - 1] ?? "";
    if (OPT_OUT.test(prev) || OPT_OUT.test(cur)) continue;
    violations.push({
      file: path.relative(repoRoot, file),
      line,
      snippet: m[0],
    });
  }
}

if (violations.length === 0) {
  console.log(
    "EL-365: no direct prisma.senderDecision writes outside the allowlist.",
  );
  process.exit(0);
}

console.error(
  "\x1b[31mEL-365 violation: direct SenderDecision writes are forbidden.\x1b[0m",
);
console.error(
  "Route SenderDecision mutations through `changeSenderDecision` / `deleteSenderDecision`",
);
console.error(
  "in apps/web/utils/sender-decision/change.ts so the audit log + structured logs stay complete.\n",
);
console.error(
  "If a specific write is genuinely telemetry-only (no action / source / note\nchange), add a `// @allow-direct-senderdecision-write: <reason>` comment on\nthe call line or the line immediately above.\n",
);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}: ${v.snippet}`);
}
console.error("");
process.exit(1);
