-- CreateEnum
CREATE TYPE "SenderAction" AS ENUM ('auto_trash', 'auto_archive', 'always_keep', 'review');

-- CreateTable
CREATE TABLE "SenderDecision" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "senderDomain" TEXT NOT NULL,
    "action" "SenderAction" NOT NULL DEFAULT 'review',
    "source" TEXT NOT NULL,
    "note" TEXT,
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "autoAppliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SenderDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SenderDecision_emailAccountId_senderEmail_key" ON "SenderDecision"("emailAccountId", "senderEmail");

-- CreateIndex
CREATE INDEX "SenderDecision_emailAccountId_senderDomain_idx" ON "SenderDecision"("emailAccountId", "senderDomain");

-- CreateIndex
CREATE INDEX "SenderDecision_emailAccountId_action_idx" ON "SenderDecision"("emailAccountId", "action");

-- AddForeignKey
ALTER TABLE "SenderDecision" ADD CONSTRAINT "SenderDecision_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
