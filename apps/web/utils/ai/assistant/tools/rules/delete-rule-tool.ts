import { type InferUITool, tool } from "ai";
import { z } from "zod";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { deleteRule } from "@/utils/rule/rule";
import { hideToolErrorFromUser } from "../../tool-error-visibility";
import type { RuleReadState } from "../../chat-rule-state";
import { trackRuleToolCall, validateRuleWasReadRecently } from "./shared";

// EL-457: deleteRule chat tool. Lets the assistant delete a Rule the user
// asks to remove (e.g. an old hand-rolled "Kickstarter" rule that's been
// superseded by a fresh AI-drafted one). Mirrors the safety posture of
// updateRuleActions: requires the rule to have been read in this turn,
// scoped to the requester's emailAccountId, deletes any owning Group.

export const deleteRuleTool = ({
  email,
  emailAccountId,
  logger,
  getRuleReadState,
}: {
  email: string;
  emailAccountId: string;
  logger: Logger;
  getRuleReadState?: () => RuleReadState | null;
}) =>
  tool({
    description:
      "Delete an existing rule by name. Use when the user asks to remove or delete a rule, or when a fresh rule supersedes an old one. The rule must be visible in the current chat context (call getUserRulesAndSettings first if you haven't). Confirms with the user when the rule is auto-running and would silently stop firing.",
    inputSchema: z.object({
      ruleName: z.string().describe("The exact name of the rule to delete."),
      confirmed: z
        .boolean()
        .nullish()
        .describe(
          "Set to true after the user has explicitly confirmed deletion. The tool refuses to delete an enabled rule unless this is true.",
        ),
    }),
    execute: async ({ ruleName, confirmed }) => {
      trackRuleToolCall({ tool: "delete_rule", email, logger });
      try {
        const readValidationError = validateRuleWasReadRecently({
          ruleName,
          getRuleReadState,
        });
        if (readValidationError) {
          return hideToolErrorFromUser({
            success: false,
            error: readValidationError,
          });
        }

        const rule = await prisma.rule.findFirst({
          where: { name: ruleName, emailAccountId },
          select: {
            id: true,
            name: true,
            enabled: true,
            groupId: true,
            lockedToSenderId: true,
          },
        });

        if (!rule) {
          return {
            success: false,
            error: `No rule named "${ruleName}" was found.`,
          };
        }

        // Safety: enabled rules require explicit user confirmation. The
        // assistant should ask the user before nuking a live rule that's
        // mutating mail every day.
        if (rule.enabled && confirmed !== true) {
          return {
            success: false,
            requiresConfirmation: true,
            error: `Rule "${rule.name}" is currently enabled. Confirm with the user that they want to delete it (and stop its auto-actions) before calling deleteRule again with confirmed:true.`,
            ruleName: rule.name,
            wasEnabled: true,
            lockedToSenderId: rule.lockedToSenderId ?? null,
          };
        }

        await deleteRule({
          emailAccountId,
          ruleId: rule.id,
          groupId: rule.groupId,
        });

        logger.info("Deleted rule via chat tool", {
          ruleId: rule.id,
          ruleName: rule.name,
          wasEnabled: rule.enabled,
        });

        return {
          success: true,
          ruleName: rule.name,
          wasEnabled: rule.enabled,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Failed to delete rule", { error });
        return { error: "Failed to delete rule", message };
      }
    },
  });

export type DeleteRuleTool = InferUITool<ReturnType<typeof deleteRuleTool>>;
