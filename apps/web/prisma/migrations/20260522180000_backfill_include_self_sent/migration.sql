-- EL-483: Backfill — exclude self-sent by default + audit excluded senders.
--
-- `includeSelfSent` is the user-facing opt-in (default false). When false,
-- the worker injects the EmailAccount's own email into the sender filter so
-- a backfill run can never act on the user's own outbox.
--
-- `excludedSenders` is the server-side audit record of what the worker
-- actually filtered out for this run (forensics if a bad rule ever escapes
-- the dry-run gate).

ALTER TABLE "BackfillRun"
  ADD COLUMN "includeSelfSent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "excludedSenders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
