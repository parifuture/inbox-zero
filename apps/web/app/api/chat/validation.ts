import { z } from "zod";
import { GroupItemType, SystemType } from "@/generated/prisma/enums";

const parsedMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string(),
  textPlain: z.string().optional(),
  textHtml: z.string().optional(),
  headers: z.object({
    from: z.string(),
    to: z.string(),
    subject: z.string(),
    cc: z.string().optional(),
    date: z.string(),
    "reply-to": z.string().optional(),
  }),
  internalDate: z.string().optional().nullable(),
});

const serializedMatchReasonSchema = z.union([
  z.object({
    type: z.literal("STATIC"),
  }),
  z.object({
    type: z.literal("LEARNED_PATTERN"),
    group: z.object({
      id: z.string(),
      name: z.string(),
    }),
    groupItem: z.object({
      id: z.string(),
      type: z.nativeEnum(GroupItemType),
      value: z.string(),
      exclude: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal("AI"),
  }),
  z.object({
    type: z.literal("PRESET"),
    systemType: z.nativeEnum(SystemType),
  }),
]);

export const serializedMatchMetadataSchema = z
  .array(serializedMatchReasonSchema)
  .nullish();

export const fixRuleContextSchema = z.object({
  type: z.literal("fix-rule"),
  message: parsedMessageSchema,
  results: z.array(
    z.object({
      ruleName: z.string().nullable(),
      systemType: z.nativeEnum(SystemType).nullable().optional(),
      reason: z.string(),
      matchMetadata: serializedMatchMetadataSchema,
    }),
  ),
  expected: z.union([
    z.literal("new"),
    z.literal("none"),
    z.union([
      z.object({
        id: z.string(),
        name: z.string(),
      }),
      z.object({
        name: z.string(),
      }),
    ]),
  ]),
});
export type FixRuleContext = z.infer<typeof fixRuleContextSchema>;

// EL-449: Sender-rule chat (per-sender chat surface on Historical Cleanup).
// The chat is permanently scoped to a single sender — the sender's email is
// locked, never editable from the chat UI. The schema enforces that lock by
// carrying `senderEmail` as the canonical scope. See EL-439 spec + 2026-05-16
// daily log for the sender-locked rule design constraint.
export const sampleMessageSchema = z.object({
  subject: z.string(),
  snippet: z.string(),
});

export const senderRuleContextSchema = z.object({
  type: z.literal("sender-rule"),
  senderEmail: z.string().email(),
  sampleMessages: z.array(sampleMessageSchema).max(50),
  existingLabels: z.array(z.string()).max(100),
});
export type SenderRuleContext = z.infer<typeof senderRuleContextSchema>;

export const messageContextSchema = z.discriminatedUnion("type", [
  fixRuleContextSchema,
  senderRuleContextSchema,
]);
export type MessageContext = z.infer<typeof messageContextSchema>;
