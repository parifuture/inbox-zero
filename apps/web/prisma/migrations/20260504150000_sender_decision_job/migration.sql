-- EL-357: background jobs that retroactively apply a SenderDecision to
-- existing Gmail messages. Phase 1: trash-only, no permanent delete.
CREATE TABLE "SenderDecisionJob" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "action" "SenderAction" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SenderDecisionJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SenderDecisionJob_emailAccountId_senderEmail_idx"
    ON "SenderDecisionJob"("emailAccountId", "senderEmail");

CREATE INDEX "SenderDecisionJob_emailAccountId_status_idx"
    ON "SenderDecisionJob"("emailAccountId", "status");

ALTER TABLE "SenderDecisionJob" ADD CONSTRAINT "SenderDecisionJob_emailAccountId_fkey"
    FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
