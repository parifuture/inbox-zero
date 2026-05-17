-- EL-457: Add TRASH to ActionType enum so rules can auto-trash incoming mail
-- (Gmail TRASH label, 30-day recoverable). NEVER permanent delete.
--
-- Postgres enum additions are non-transactional; ALTER TYPE ... ADD VALUE
-- must run outside a transaction. Prisma migrate runs each migration in its
-- own transaction by default, so we either need IF NOT EXISTS (Postgres
-- 12+) or to detect duplicates. Postgres 16 supports IF NOT EXISTS — used
-- here for idempotency.
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'TRASH';
