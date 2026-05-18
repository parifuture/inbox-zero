/**
 * EL-469 — LLM evaluator for the smart historical backfill.
 *
 * Given a sender's history (a single chunk of MirrorEmailRow) plus the
 * user's selected rule definitions, ask Bedrock Sonnet to return a
 * disposition for every messageId.
 *
 * The model is asked to be strict — when uncertain, SKIP. Reply/forward
 * are explicitly off-limits in backfill mode (too dangerous on historical
 * mail; if the user wants those, they can run the live Test/Apply page).
 *
 * Output schema is Zod-validated. Every messageId in the input MUST
 * appear in the output exactly once; any messages the model omits are
 * back-filled with `SKIP` server-side as a defensive default.
 */

import { z } from "zod";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { RuleWithRelations } from "@/utils/rule/types";
import { createGenerateObject } from "@/utils/llms";
import { getModel } from "@/utils/llms/model";
import { createScopedLogger } from "@/utils/logger";
import type { MirrorEmailRow } from "@/utils/backfill/mirror";
const logger = createScopedLogger("backfill-evaluator");

/**
 * Allowed dispositions. Deliberately a strict subset of `ActionType` —
 * REPLY / SEND_EMAIL / FORWARD / DRAFT_* are unsafe to apply
 * automatically to historical mail. Anything ambiguous gets SKIP.
 */
export const BACKFILL_ACTIONS = [
  "ARCHIVE",
  "TRASH",
  "MARK_READ",
  "LABEL",
  "SKIP",
] as const;
export type BackfillAction = (typeof BACKFILL_ACTIONS)[number];

export const evaluatorDecisionSchema = z.object({
  messageId: z.string().min(1),
  action: z.enum(BACKFILL_ACTIONS),
  /** Required when `action === "LABEL"`; ignored otherwise. */
  labelName: z.string().nullable().optional(),
  /** Selected rule's id. Null/omitted when no rule applied (action will be SKIP). */
  ruleId: z.string().nullable().optional(),
  /** Brief LLM rationale. Truncated to 500 chars at write time. */
  reason: z.string().min(1).max(2000),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
});
export type EvaluatorDecision = z.infer<typeof evaluatorDecisionSchema>;

export const evaluatorOutputSchema = z.object({
  decisions: z.array(evaluatorDecisionSchema),
});

/**
 * One LLM call's worth of input. The caller (worker) decides chunk
 * boundaries based on `MirrorReader.loadSenderHistory`. Default chunk
 * size is 200 emails per call.
 */
export interface EvaluateChunkArgs {
  emailAccount: EmailAccountWithAI;
  emails: MirrorEmailRow[];
  modelLabel?: string;
  rules: RuleWithRelations[];
  sender: string;
}

/** Maximum body bytes per email we send to the model. Keeps token costs bounded. */
const PER_EMAIL_BODY_CHARS = 600;
/** Hard cap on emails per single call. The worker should chunk above this. */
export const MAX_EMAILS_PER_EVALUATION = 200;

function trimBody(text: string): string {
  if (!text) return "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= PER_EMAIL_BODY_CHARS) return trimmed;
  return `${trimmed.slice(0, PER_EMAIL_BODY_CHARS)}…`;
}

/**
 * Compact JSON-ish description of a rule the model can reason about.
 * We don't dump the entire schema — actions (ArchiveAction, TrashAction,
 * LabelAction…) are reduced to a single action verb + optional label.
 */
function describeRule(rule: RuleWithRelations): {
  id: string;
  name: string;
  instructions: string | null;
  actions: { type: string; label?: string | null }[];
  lockedToSenderId?: string | null;
} {
  return {
    id: rule.id,
    name: rule.name,
    instructions: rule.instructions ?? null,
    actions: rule.actions.map((a) => ({
      type: a.type,
      label: a.label ?? null,
    })),
    // EL-452 — sender-locked rules should only consider their own
    // sender (FK to SenderDecision). The evaluator already scopes by
    // sender, but surfacing the lock id helps the LLM disambiguate
    // between a sender-specific rule and a generic newsletter rule.
    lockedToSenderId: rule.lockedToSenderId ?? null,
  };
}

function buildSystemPrompt(): string {
  return [
    "You are an email triage classifier evaluating historical mail against user-defined rules.",
    "",
    "For EACH email you are given, return EXACTLY ONE disposition from this list:",
    "  - ARCHIVE      Remove from Inbox, keep the message.",
    "  - TRASH        Move to Gmail Trash (30-day recoverable, never permanent).",
    "  - MARK_READ    Mark as read but leave in place.",
    "  - LABEL        Apply a Gmail label (set `labelName`).",
    "  - SKIP         Take no action.",
    "",
    "Return JSON matching the schema. Every input messageId MUST appear",
    "exactly once in your `decisions` array.",
    "",
    "Rules of engagement:",
    "  1. Be strict. If you are even a little unsure, choose SKIP.",
    "  2. Only apply a disposition that one of the user's rules supports.",
    "     Set `ruleId` to the rule whose action you used.",
    "  3. NEVER reply, forward, send, or draft messages — those are not",
    "     valid backfill dispositions. Use SKIP for those cases.",
    "  4. Reasoning must be short — one sentence — and reference WHY the",
    "     rule matches (e.g. 'matches Newsletter rule: bulk sender, no",
    "     personal cues').",
    "  5. Confidence: 'high' for obvious matches, 'medium' for plausible,",
    "     'low' if you only weakly believe the rule applies. Low-confidence",
    "     decisions will be flagged for human review downstream.",
    "  6. If two rules could apply, prefer the more specific one (e.g.",
    "     a sender-locked rule beats a generic newsletter rule).",
    "",
    "Output strict JSON only. Do not narrate.",
  ].join("\n");
}

function buildUserPrompt(args: {
  sender: string;
  rules: RuleWithRelations[];
  emails: MirrorEmailRow[];
}): string {
  const ruleSummaries = args.rules.map(describeRule);
  const emailSummaries = args.emails.map((e) => ({
    messageId: e.id,
    date: e.dateSent.toISOString(),
    subject: e.subject || "(no subject)",
    snippet: e.snippet,
    body: trimBody(e.bodyText),
    labels: e.labels,
  }));
  return [
    `Sender: ${args.sender}`,
    `Email count: ${args.emails.length}`,
    "",
    "Rules selected for this run:",
    JSON.stringify(ruleSummaries, null, 2),
    "",
    "Emails to evaluate (newest first):",
    JSON.stringify(emailSummaries, null, 2),
    "",
    "Reply with the JSON object described in the schema. Every messageId",
    "above must appear in `decisions` exactly once.",
  ].join("\n");
}

/**
 * Evaluate one chunk of a sender's history. Returns a decision per
 * input messageId, with omissions filled in as SKIP defensively.
 */
export async function evaluateSenderChunk(
  args: EvaluateChunkArgs,
): Promise<EvaluatorDecision[]> {
  if (args.emails.length === 0) return [];
  if (args.emails.length > MAX_EMAILS_PER_EVALUATION) {
    throw new Error(
      `evaluateSenderChunk: chunk size ${args.emails.length} exceeds MAX_EMAILS_PER_EVALUATION ${MAX_EMAILS_PER_EVALUATION}`,
    );
  }

  // The model selection lives at the User level (UserAIFields). The
  // EmailAccountWithAI Prisma payload includes `user` for that purpose.
  const modelOptions = getModel(args.emailAccount.user, "economy");
  const generateObject = createGenerateObject({
    emailAccount: args.emailAccount,
    label: args.modelLabel ?? "Backfill: evaluate sender chunk",
    modelOptions,
    promptHardening: { trust: "untrusted", level: "compact" },
  });

  const system = buildSystemPrompt();
  const prompt = buildUserPrompt({
    sender: args.sender,
    rules: args.rules,
    emails: args.emails,
  });

  logger.info("evaluateSenderChunk request", {
    sender: args.sender,
    emails: args.emails.length,
    rules: args.rules.length,
  });

  const ai = await generateObject({
    ...modelOptions,
    system,
    prompt,
    schema: evaluatorOutputSchema,
  });

  const fromModel = ai.object.decisions;
  const indexedById = new Map(fromModel.map((d) => [d.messageId, d]));

  // Defensive: ensure every input messageId is represented. The LLM
  // sometimes drops a row it deems uninteresting — we treat that as
  // explicit SKIP rather than silent omission.
  const out: EvaluatorDecision[] = [];
  for (const e of args.emails) {
    const found = indexedById.get(e.id);
    if (found) {
      // Normalize: enforce LABEL has a labelName, otherwise downgrade to SKIP.
      if (found.action === "LABEL" && !found.labelName) {
        out.push({
          ...found,
          action: "SKIP",
          ruleId: null,
          reason: `LABEL action returned without labelName — downgraded to SKIP. Original reason: ${found.reason}`,
          confidence: "low",
        });
      } else {
        out.push(found);
      }
    } else {
      out.push({
        messageId: e.id,
        action: "SKIP",
        ruleId: null,
        reason: "Model omitted this messageId; defaulted to SKIP.",
        confidence: "low",
      });
    }
  }

  // And clip any decisions for messageIds we did NOT send (model
  // hallucination). Don't fail the whole chunk on that — just drop.
  const knownIds = new Set(args.emails.map((e) => e.id));
  for (const d of fromModel) {
    if (!knownIds.has(d.messageId)) {
      logger.warn("evaluateSenderChunk: model returned unknown messageId", {
        sender: args.sender,
        unknownId: d.messageId,
      });
    }
  }

  return out;
}
