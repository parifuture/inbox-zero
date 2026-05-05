-- EL-384a: persist user-chosen Gmail label to apply to kept messages.
ALTER TABLE "SenderDecision"
  ADD COLUMN "keepLabelId" TEXT,
  ADD COLUMN "keepLabelName" TEXT;
