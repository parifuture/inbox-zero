-- EL-365: extend SenderDecisionAudit with source + reason.
--
-- `source` distinguishes the surface that produced the change (e.g.
-- "ui:decisions", "ui:historical-cleanup", "api:import", "rule",
-- "llm_suggestion", "parity-runner"). `reason` is an optional free-text
-- explanation useful for debugging cascades (e.g. "bulk apply in import
-- preview", "auto-cleanup seed").
--
-- Both are nullable because existing rows predate them and we don't want
-- to backfill synthetic values.

ALTER TABLE "SenderDecisionAudit"
  ADD COLUMN "source" TEXT,
  ADD COLUMN "reason" TEXT;

CREATE INDEX "SenderDecisionAudit_source_idx"
  ON "SenderDecisionAudit" ("emailAccountId", "source");
