import type { Prisma, SenderDecision } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";

export type AuditActor = "user" | "system" | "seed" | (string & {});
export type AuditAction = "create" | "update" | "delete" | "bulk";

export async function logDecisionAudit(params: {
  emailAccountId: string;
  senderEmail: string;
  before: SenderDecision | null;
  after: SenderDecision | null;
  actor: AuditActor;
  action: AuditAction;
}): Promise<void> {
  await prisma.senderDecisionAudit.create({
    data: {
      emailAccountId: params.emailAccountId,
      senderEmail: params.senderEmail,
      before: (params.before as unknown as Prisma.InputJsonValue) ?? undefined,
      after: (params.after as unknown as Prisma.InputJsonValue) ?? undefined,
      actor: params.actor,
      action: params.action,
    },
  });
}
