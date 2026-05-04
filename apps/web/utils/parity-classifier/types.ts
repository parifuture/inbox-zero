/**
 * EL-358a — parity classifier types.
 *
 * Ported verbatim from sidecar `~/code/no-more-spam-pls/agent-workspace/sidecar/src/types.ts`.
 * These are intentionally decoupled from Prisma models so the classifier can
 * run as a pure function in unit tests. Shadow-mode wiring (EL-358b) will
 * bridge these into fork types and persist results to `ParityDecision`.
 */

export interface ParsedEmail {
  addrSpec: string; // RFC 5322 addr-spec: alice@example.com
  date: Date;
  domain: string; // example.com
  fromRaw: string; // raw From header (may include display name)
  /** true if caller already saw a `List-Unsubscribe` header (prompt fallback) */
  listUnsubscribeInPrompt: boolean;
  subject: string;
}

export interface GmailHeaders {
  autoSubmitted?: string;
  gmailMessageId?: string; // value of Message-Id header
  inReplyTo?: string;
  listId?: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  messageId: string; // Gmail internal message ID
}

export type ParityAction = "inbox" | "review" | "noMatch" | "trash";
export type ParityStage = 0 | 1 | 2 | 3 | 4;

export interface PipelineResult {
  action: ParityAction;
  bedrockUsed: boolean;
  /** Stage 4 only */
  category?: string | null;
  gmailFetchFailed: boolean;
  headers?: GmailHeaders;
  /** Stage 4 only */
  labelAssigned?: string | null;
  reasoning: string;
  ruleName: string | null;
  stage: ParityStage;
}

/**
 * Per-sender activity aggregate used by the personal-priority scorer.
 * In the sidecar this was sourced from a bespoke `sender_aggregate` table;
 * in the fork (EL-358b) it will be sourced from `EmailMessage` rollups.
 */
export interface SenderAggregate {
  address: string;
  domain: string;
  firstSeen: Date | null;
  /** 0.0 = they always initiate, 1.0 = you always initiate */
  initiationRatio: number;
  lastReceived: Date | null;
  lastReplied: Date | null;
  replyCount: number;
  totalReceivedFrom: number;
  totalSentToThem: number;
}

export interface ScoreResult {
  daysSinceLastReply: number | null;
  initiationRatio: number;
  initiationScore: number;
  recencyScore: number;
  replyCount: number;
  replyScore: number;
  score: number;
  source: "history" | "domain_prior" | "no_data";
  totalReceived: number;
  volumeScore: number;
}

export interface ClassificationResult {
  category: "PERSONAL" | "TRANSACTIONAL" | "BULK";
  confidence: number;
  label: string | null;
  reasoning: string;
  requiresReply: boolean;
}
