-- CreateTable
CREATE TABLE "HistoricalSenderScan" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalEstimate" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cutoffDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalSenderScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalSender" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "senderName" TEXT,
    "domain" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "firstDate" TIMESTAMP(3) NOT NULL,
    "lastDate" TIMESTAMP(3) NOT NULL,
    "category" TEXT,
    "archivedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalSender_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalSenderScan_emailAccountId_key" ON "HistoricalSenderScan"("emailAccountId");

-- CreateIndex
CREATE INDEX "HistoricalSender_emailAccountId_count_idx" ON "HistoricalSender"("emailAccountId", "count");

-- CreateIndex
CREATE INDEX "HistoricalSender_emailAccountId_lastDate_idx" ON "HistoricalSender"("emailAccountId", "lastDate");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalSender_emailAccountId_senderEmail_key" ON "HistoricalSender"("emailAccountId", "senderEmail");

-- AddForeignKey
ALTER TABLE "HistoricalSenderScan" ADD CONSTRAINT "HistoricalSenderScan_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalSender" ADD CONSTRAINT "HistoricalSender_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
