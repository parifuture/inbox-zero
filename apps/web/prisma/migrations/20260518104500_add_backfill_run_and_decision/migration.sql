-- EL-468 / EL-470 — Smart Historical Backfill schema.
--
-- BackfillRun stores a single user-initiated historical-rule-application
-- session (rule selection, scope, dry-run flag, progress counters, status).
--
-- BackfillDecision stores ONE row per Gmail message that the LLM
-- evaluator inspected. The row is written BEFORE Gmail is mutated so:
--   - dry-run mode (Phase 1 default) lets the user audit decisions before
--     pressing Execute,
--   - the executor is idempotent / resumable: SELECT WHERE executedAt
--     IS NULL picks up where a crashed worker left off,
--   - per-decision Gmail errors land in executionError without aborting
--     the rest of the run.
--
-- No enum types — using TEXT for status/action so future additions don't
-- require enum-add migrations (Postgres enum changes are non-transactional
-- and we already have one painful one — see 20260517141500_add_action_type_trash).

-- BackfillRun ----------------------------------------------------------------

CREATE TABLE "BackfillRun" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ruleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "dateFloor" TIMESTAMP(3),
    "senderScope" TEXT,
    "modelId" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "totalSenders" INTEGER NOT NULL DEFAULT 0,
    "processedSenders" INTEGER NOT NULL DEFAULT 0,
    "totalDecisions" INTEGER NOT NULL DEFAULT 0,
    "executedDecisions" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "currentSender" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BackfillRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BackfillRun_emailAccountId_status_idx"
    ON "BackfillRun"("emailAccountId", "status");
CREATE INDEX "BackfillRun_emailAccountId_createdAt_idx"
    ON "BackfillRun"("emailAccountId", "createdAt");

ALTER TABLE "BackfillRun"
    ADD CONSTRAINT "BackfillRun_emailAccountId_fkey"
    FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- BackfillDecision -----------------------------------------------------------

CREATE TABLE "BackfillDecision" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadId" TEXT,
    "sender" TEXT NOT NULL,
    "ruleId" TEXT,
    "action" TEXT NOT NULL,
    "labelName" TEXT,
    "reason" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),
    "executionError" TEXT,

    CONSTRAINT "BackfillDecision_pkey" PRIMARY KEY ("id")
);

-- (runId, executedAt) is the hot index for the executor — it pulls
-- WHERE runId = ? AND executedAt IS NULL ORDER BY decidedAt to apply
-- decisions in the order the LLM produced them.
CREATE INDEX "BackfillDecision_runId_executedAt_idx"
    ON "BackfillDecision"("runId", "executedAt");

-- (runId, sender) drives the "currently working on sender X" UI tail
-- and per-sender filtering on the audit table.
CREATE INDEX "BackfillDecision_runId_sender_idx"
    ON "BackfillDecision"("runId", "sender");

-- (runId, action) drives the per-rule counters (we GROUP BY action +
-- ruleId in a single query for the live progress table).
CREATE INDEX "BackfillDecision_runId_action_idx"
    ON "BackfillDecision"("runId", "action");

-- (messageId) lets the executor — or any future re-run protection —
-- ask "has THIS message already been actioned by some prior run?"
CREATE INDEX "BackfillDecision_messageId_idx"
    ON "BackfillDecision"("messageId");

ALTER TABLE "BackfillDecision"
    ADD CONSTRAINT "BackfillDecision_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "BackfillRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
