-- EL-448: Schema for sender-locked rules + per-sender chat threads
-- See parent EL-439 for full design context.
--
-- Two backward-compatible additions:
--   1. Rule.lockedToSenderId — when non-null, rule is locked to a sender
--      (cannot edit from-condition; only delete the rule entirely).
--   2. Chat.senderEmail — when non-null, this Chat is the persistent per-sender
--      thread for creating sender-locked rules. Each (emailAccount, senderEmail)
--      pair has at most one chat.

-- Add nullable column for sender-lock on Rule
ALTER TABLE "Rule" ADD COLUMN "lockedToSenderId" TEXT;

-- Index for filtering Rules list by sender-lock status / sender-email lookups
CREATE INDEX "Rule_lockedToSenderId_idx" ON "Rule"("lockedToSenderId");

-- Add nullable column for per-sender thread keying on Chat
ALTER TABLE "Chat" ADD COLUMN "senderEmail" TEXT;

-- Unique constraint: each (emailAccount, senderEmail) pair has at most one Chat.
-- General-purpose chats keep senderEmail = NULL and are unaffected (Postgres
-- treats NULL values as distinct in unique constraints, so multiple NULLs OK).
CREATE UNIQUE INDEX "Chat_emailAccountId_senderEmail_key" ON "Chat"("emailAccountId", "senderEmail");

-- Index for direct lookups by senderEmail (cross-account analytics, etc.)
CREATE INDEX "Chat_senderEmail_idx" ON "Chat"("senderEmail");
