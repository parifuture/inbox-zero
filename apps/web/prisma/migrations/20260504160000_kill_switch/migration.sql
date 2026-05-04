-- EL-370 kill-switch: columns on EmailAccount for paused state + metadata,
-- plus a flag on ExecutedRule marking rules suppressed by the kill-switch.
ALTER TABLE "EmailAccount"
    ADD COLUMN "autonomousActionsPaused" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "autonomousActionsPausedAt" TIMESTAMP(3),
    ADD COLUMN "autonomousActionsPausedBy" TEXT,
    ADD COLUMN "autonomousActionsPauseReason" TEXT;

ALTER TABLE "ExecutedRule"
    ADD COLUMN "suppressedByKillSwitch" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "ExecutedRule_emailAccountId_suppressedByKillSwitch_createdAt_idx"
    ON "ExecutedRule"("emailAccountId", "suppressedByKillSwitch", "createdAt");
