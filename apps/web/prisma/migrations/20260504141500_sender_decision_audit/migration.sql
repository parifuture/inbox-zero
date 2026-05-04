-- CreateTable
CREATE TABLE "SenderDecisionAudit" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SenderDecisionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SenderDecisionAudit_emailAccountId_senderEmail_idx" ON "SenderDecisionAudit"("emailAccountId", "senderEmail");

-- CreateIndex
CREATE INDEX "SenderDecisionAudit_emailAccountId_createdAt_idx" ON "SenderDecisionAudit"("emailAccountId", "createdAt");

-- AddForeignKey
ALTER TABLE "SenderDecisionAudit" ADD CONSTRAINT "SenderDecisionAudit_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
