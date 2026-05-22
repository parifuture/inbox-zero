-- EL-484: Add @@unique([runId, messageId]) to BackfillDecision.
--
-- Without this constraint, createMany({ skipDuplicates: true }) is a no-op
-- and any retry of evaluateRun for an in-flight run silently inserts duplicate
-- decision rows. See worker.ts:209-212 for the original TODO.
--
-- Pre-flight: cull any existing duplicates (keeping the row with the SMALLEST id,
-- so audit-log timestamps remain anchored to the first observation). Wrapped
-- in the migration's implicit transaction.

-- Step 1: Cull existing duplicates, if any.
-- Postgres window function — keeps the lowest cuid per (runId, messageId).
DELETE FROM "BackfillDecision" a
USING "BackfillDecision" b
WHERE a."runId" = b."runId"
  AND a."messageId" = b."messageId"
  AND a.id > b.id;

-- Step 2: Add the unique constraint.
CREATE UNIQUE INDEX "BackfillDecision_runId_messageId_key"
  ON "BackfillDecision"("runId", "messageId");
