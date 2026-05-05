-- EL-361b: strip Cold Email Blocker backend.
--
-- Removes the ColdEmail table, its DigestItem FK, the legacy ColdEmail* columns
-- on EmailAccount, and the ColdEmailStatus / ColdEmailSetting enums. The
-- SystemType enum value `COLD_EMAIL` is intentionally kept because Postgres
-- cannot drop enum values cleanly; instead we delete any existing rules and
-- related actions so the value becomes inert.
--
-- This is a destructive migration. Any Rule configured as the Cold Email
-- blocker (and its Actions / ExecutedRule history / learned-pattern Group) is
-- removed. Execution log for COLD_EMAIL rules is preserved in audit tables if
-- they cascade on delete; otherwise it is cleaned up alongside the Rule rows.

BEGIN;

-- 1. Drop the ColdEmail FK column on DigestItem (and its index). The relation
--    was already @deprecated; after this we can safely drop the ColdEmail table.
DROP INDEX IF EXISTS "DigestItem_coldEmailId_idx";
ALTER TABLE "DigestItem" DROP COLUMN IF EXISTS "coldEmailId";

-- 2. Drop the ColdEmail table (indexes + unique constraint go with it).
DROP TABLE IF EXISTS "ColdEmail" CASCADE;

-- 3. Drop the legacy ColdEmail-related columns on EmailAccount.
ALTER TABLE "EmailAccount"
  DROP COLUMN IF EXISTS "coldEmailBlocker",
  DROP COLUMN IF EXISTS "coldEmailDigest",
  DROP COLUMN IF EXISTS "coldEmailPrompt";

-- 4. Delete any Rule rows still marked as the Cold Email blocker. Action rows
--    cascade via the Rule FK; ExecutedRule rows keep `ruleId` nullable so we
--    null out references first to avoid FK violations.
UPDATE "ExecutedRule" SET "ruleId" = NULL
  WHERE "ruleId" IN (SELECT id FROM "Rule" WHERE "systemType" = 'COLD_EMAIL');

DELETE FROM "Rule" WHERE "systemType" = 'COLD_EMAIL';

-- 5. Drop the now-unused enums. SystemType.COLD_EMAIL stays in place because
--    the enum value cannot be removed without rewriting every dependent table.
DROP TYPE IF EXISTS "ColdEmailStatus";
DROP TYPE IF EXISTS "ColdEmailSetting";

COMMIT;
