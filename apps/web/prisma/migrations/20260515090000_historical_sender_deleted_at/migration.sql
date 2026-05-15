-- Add deletedAt for tracking senders whose mail has been moved to Trash via Historical Cleanup.
-- Move-to-Trash is the explicit semantic: Gmail keeps trashed mail for 30 days, never permanent.
ALTER TABLE "HistoricalSender" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "HistoricalSender_emailAccountId_deletedAt_idx" ON "HistoricalSender"("emailAccountId", "deletedAt");
