import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import {
  getKillSwitchStatus,
  setAutonomousPaused,
  type KillSwitchStatus,
} from "@/utils/kill-switch";

export type KillSwitchGetResponse = KillSwitchStatus;
export type KillSwitchPostResponse = KillSwitchStatus;

const postSchema = z.object({
  paused: z.boolean(),
  reason: z.string().max(500).nullable().optional(),
});

export const GET = withEmailAccount("kill-switch/get", async (request) => {
  const { emailAccountId } = request.auth;
  const status = await getKillSwitchStatus(emailAccountId, {
    skipCache: true,
  });
  return NextResponse.json<KillSwitchGetResponse>(status);
});

export const POST = withEmailAccount("kill-switch/post", async (request) => {
  const { emailAccountId, userId } = request.auth;

  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const status = await setAutonomousPaused({
    emailAccountId,
    paused: parsed.data.paused,
    reason: parsed.data.reason ?? null,
    actor: userId,
    logger: request.logger,
  });

  return NextResponse.json<KillSwitchPostResponse>(status);
});
