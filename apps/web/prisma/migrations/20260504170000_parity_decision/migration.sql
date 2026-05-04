-- EL-358a — ParityDecision shadow-mode table.
--
-- One row per message the fork's new 4-stage classifier evaluated. NEVER used
-- to drive Gmail mutations; the sidecar remains the source of truth until
-- EL-363 verifies agreement. Writes land in EL-358b (shadow runner); EL-358a
-- creates the table only.

CREATE TABLE "ParityDecision" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadId" TEXT,
    "senderEmail" TEXT NOT NULL,
    "senderDomain" TEXT NOT NULL,
    "subject" TEXT,
    "stage" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "ruleName" TEXT,
    "category" TEXT,
    "labelAssigned" TEXT,
    "score" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "reasoning" TEXT,
    "bedrockUsed" BOOLEAN NOT NULL DEFAULT false,
    "gmailFetchFailed" BOOLEAN NOT NULL DEFAULT false,
    "sidecarAction" TEXT,
    "sidecarRuleName" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParityDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ParityDecision_emailAccountId_messageId_key"
    ON "ParityDecision"("emailAccountId", "messageId");

CREATE INDEX "ParityDecision_emailAccountId_senderEmail_idx"
    ON "ParityDecision"("emailAccountId", "senderEmail");

CREATE INDEX "ParityDecision_emailAccountId_createdAt_idx"
    ON "ParityDecision"("emailAccountId", "createdAt");

CREATE INDEX "ParityDecision_emailAccountId_stage_idx"
    ON "ParityDecision"("emailAccountId", "stage");

ALTER TABLE "ParityDecision"
    ADD CONSTRAINT "ParityDecision_emailAccountId_fkey"
    FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
