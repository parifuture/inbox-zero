/**
 * EL-358b \u2014 Stage 4 (Bedrock) classifier via the fork's LLM abstraction.
 *
 * We intentionally do NOT import `@aws-sdk/client-bedrock-runtime` here.
 * The fork already has a provider-agnostic `createGenerateObject` wrapper
 * that gives us retries, fallback models, usage tracking, and budget
 * controls \u2014 the shadow runner should inherit all of that for free.
 *
 * The prompt text is ported verbatim from sidecar `classify.ts` so the
 * parity-verification harness (EL-363) can compare apples to apples.
 */

import { z } from "zod";
import { createGenerateObject } from "@/utils/llms";
import { getModel } from "@/utils/llms/model";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { createScopedLogger } from "@/utils/logger";
import type { ClassificationResult } from "./types";

const logger = createScopedLogger("parity-classifier/bedrock");

const CATEGORY_SCHEMA = z.enum(["PERSONAL", "TRANSACTIONAL", "BULK"]);

const CLASSIFICATION_SCHEMA = z.object({
  category: CATEGORY_SCHEMA,
  label: z.string().nullable(),
  requiresReply: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

function buildSystemPrompt(score: number): string {
  return `You are classifying an incoming email for a personal Gmail inbox.

Respond with ONLY a valid JSON object. No prose, no markdown, no code fences.

CATEGORY \u2014 choose exactly one:
  PERSONAL      \u2014 a real person wrote this specifically to reach the recipient
  TRANSACTIONAL \u2014 automated, triggered by something the recipient did
                  (order confirmation, shipping update, bank alert, 2FA code,
                   receipt, calendar invite, booking confirmation)
  BULK          \u2014 marketing, newsletter, or unrequested notification

LABEL \u2014 choose exactly one, or null:
  null                     \u2014 always use for PERSONAL; use for TRANSACTIONAL/BULK if none fit
  "Deliveries"             \u2014 shipping & package tracking
  "Finance"                \u2014 banks, payments, crypto, insurance, tax
  "Receipts/Food Delivery" \u2014 Uber Eats, DoorDash, Caviar, Grubhub
  "Receipts/Groceries"     \u2014 Good Eggs, Instacart, Costco, Target, Safeway, Whole Foods
  "Dev/Cloud"              \u2014 GitHub, AWS, Vercel, cloud platforms, developer tools
  "Kickstarter"            \u2014 backed project updates
  "Tesla"                  \u2014 Tesla vehicle or insurance emails
  "DMV"                    \u2014 California DMV
  "CryptoTax"              \u2014 cryptotaxgirl.com
  "Services"               \u2014 app and service account emails (login, settings, subscription)
  "Newsletter"             \u2014 newsletters, digests, subscriptions, editorial content
  "Review"                 \u2014 uncertain; use when none of the above clearly fits

RULES:
  - PERSONAL emails always get label null.
  - Legal emails (bankruptcy, disputes, court notices) are handled upstream \u2014 never classify them here.
  - Set requiresReply true if the email expects a response from the recipient.
  - Use confidence below 0.60 if genuinely uncertain.

Relationship score for this sender: ${score.toFixed(2)} (0.0 = complete stranger, 1.0 = close contact)

Required JSON shape:
{
  "category": "PERSONAL" | "TRANSACTIONAL" | "BULK",
  "label": string | null,
  "requiresReply": boolean,
  "confidence": number,
  "reasoning": string
}`;
}

export type ParityEmailPayload = {
  from: string;
  subject: string;
  content: string;
  date?: Date;
  listUnsubscribe?: string;
};

function buildUserPrompt(email: ParityEmailPayload): string {
  const parts: string[] = [];
  parts.push(`From: ${email.from}`);
  if (email.date) parts.push(`Date: ${email.date.toISOString()}`);
  parts.push(`Subject: ${email.subject}`);
  if (email.listUnsubscribe)
    parts.push(`List-Unsubscribe: ${email.listUnsubscribe}`);
  parts.push("");
  parts.push(email.content);
  return parts.join("\n");
}

/**
 * Invoke the Stage 4 content classifier. Returns `null` on any failure \u2014
 * the caller treats null as a safe fallback to Review (same contract as
 * the sidecar).
 */
export async function classifyEmailForParity(
  emailAccount: Pick<EmailAccountWithAI, "id" | "email" | "userId" | "user">,
  email: ParityEmailPayload,
  score: number,
): Promise<ClassificationResult | null> {
  try {
    const modelOptions = getModel(emailAccount.user, "chat");

    const generateObject = createGenerateObject({
      emailAccount,
      label: "parity-classifier/stage4",
      modelOptions,
      promptHardening: { trust: "untrusted", level: "full" },
    });

    const result = await generateObject({
      ...modelOptions,
      system: buildSystemPrompt(score),
      prompt: buildUserPrompt(email),
      schema: CLASSIFICATION_SCHEMA,
    });

    const parsed = result.object;
    if (!parsed) return null;

    return {
      category: parsed.category,
      label: parsed.label,
      requiresReply: parsed.requiresReply,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
    };
  } catch (error) {
    logger.warn("parity.stage4.failed", {
      emailAccountId: emailAccount.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Exported for tests that want to assert against the exact prompt template.
export const __internals = { buildSystemPrompt, buildUserPrompt };
