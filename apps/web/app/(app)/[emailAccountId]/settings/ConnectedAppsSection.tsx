"use client";

import { useState } from "react";
import {
  MessageCircleIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { CopyInput } from "@/components/CopyInput";
import { SlackNotificationTargetSelect } from "@/components/SlackNotificationTargetSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingContent } from "@/components/LoadingContent";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemActions,
  ItemSeparator,
} from "@/components/ui/item";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toastSuccess, toastError } from "@/components/Toast";
import { useMessagingChannels } from "@/hooks/useMessagingChannels";
import {
  createMessagingLinkCodeAction,
  disconnectChannelAction,
} from "@/utils/actions/messaging-channels";
import { getActionErrorMessage } from "@/utils/error";
import {
  type MessagingProvider,
  MessagingRoutePurpose,
} from "@/generated/prisma/enums";

type LinkableMessagingProvider = "TEAMS" | "TELEGRAM";

const PROVIDER_CONFIG: Partial<
  Record<MessagingProvider, { name: string; icon: typeof MessageSquareIcon }>
> = {
  SLACK: { name: "Slack", icon: MessagesSquareIcon },
  TEAMS: { name: "Teams", icon: MessageCircleIcon },
  TELEGRAM: { name: "Telegram", icon: SendIcon },
};

export function ConnectedAppsSection({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  const {
    data: channelsData,
    isLoading,
    error,
    mutate: mutateChannels,
  } = useMessagingChannels(emailAccountId);
  const [linkCodeDialog, setLinkCodeDialog] = useState<{
    provider: LinkableMessagingProvider;
    code: string;
    botUrl?: string | null;
  } | null>(null);

  const connectedChannels =
    channelsData?.channels.filter((channel) => channel.isConnected) ?? [];
  const hasTeams = connectedChannels.some(
    (channel) => channel.provider === "TEAMS",
  );
  const hasTelegram = connectedChannels.some(
    (channel) => channel.provider === "TELEGRAM",
  );
  const teamsAvailable =
    channelsData?.availableProviders?.includes("TEAMS") ?? false;
  const telegramAvailable =
    channelsData?.availableProviders?.includes("TELEGRAM") ?? false;

  const { execute: executeCreateLinkCode, status: linkCodeStatus } = useAction(
    createMessagingLinkCodeAction.bind(null, emailAccountId),
    {
      onSuccess: ({ data }) => {
        if (!data?.code || !data.provider) return;
        setLinkCodeDialog({
          provider: data.provider,
          code: data.code,
          botUrl: data.botUrl || null,
        });
      },
      onError: (error) => {
        toastError({
          description:
            getActionErrorMessage(error.error) ?? "Failed to generate code",
        });
      },
    },
  );

  if (
    !isLoading &&
    !teamsAvailable &&
    !telegramAvailable &&
    connectedChannels.length === 0
  )
    return null;

  const handleCreateLinkCode = (provider: LinkableMessagingProvider) => {
    executeCreateLinkCode({ provider });
  };

  return (
    <>
      <ItemSeparator />
      <Item size="sm">
        <ItemContent>
          <ItemTitle>Connected Apps</ItemTitle>
        </ItemContent>
        <ItemActions>
          <div className="flex items-center gap-2">
            {!hasTeams && teamsAvailable && (
              <Button
                variant="outline"
                size="sm"
                disabled={linkCodeStatus === "executing"}
                onClick={() => handleCreateLinkCode("TEAMS")}
              >
                <MessageCircleIcon className="mr-2 h-4 w-4" />
                Connect Teams
              </Button>
            )}

            {!hasTelegram && telegramAvailable && (
              <Button
                variant="outline"
                size="sm"
                disabled={linkCodeStatus === "executing"}
                onClick={() => handleCreateLinkCode("TELEGRAM")}
              >
                <SendIcon className="mr-2 h-4 w-4" />
                Connect Telegram
              </Button>
            )}
          </div>
        </ItemActions>
      </Item>
      <LoadingContent loading={isLoading} error={error} loadingComponent={null}>
        {connectedChannels.length > 0 && (
          <div className="space-y-2 px-4 pb-3">
            {connectedChannels.map((channel) => (
              <ConnectedChannelRow
                key={channel.id}
                channel={channel}
                emailAccountId={emailAccountId}
                onUpdate={mutateChannels}
              />
            ))}
          </div>
        )}
      </LoadingContent>
      <MessagingConnectCodeDialog
        open={Boolean(linkCodeDialog)}
        provider={linkCodeDialog?.provider ?? null}
        code={linkCodeDialog?.code ?? null}
        botUrl={linkCodeDialog?.botUrl ?? null}
        onOpenChange={(open) => {
          if (!open) setLinkCodeDialog(null);
        }}
      />
    </>
  );
}

function ConnectedChannelRow({
  channel,
  emailAccountId,
  onUpdate,
}: {
  channel: {
    id: string;
    provider: MessagingProvider;
    teamName: string | null;
    canSendAsDm: boolean;
    destinations: {
      ruleNotifications: {
        targetId: string | null;
        targetLabel: string | null;
        isDm: boolean;
      };
    };
  };
  emailAccountId: string;
  onUpdate: () => void;
}) {
  const config = PROVIDER_CONFIG[channel.provider];
  const Icon = config?.icon ?? MessageSquareIcon;
  const isSlackChannel = channel.provider === "SLACK";

  const { execute: executeDisconnect, status: disconnectStatus } = useAction(
    disconnectChannelAction.bind(null, emailAccountId),
    {
      onSuccess: () => {
        toastSuccess({
          description: `${config?.name ?? channel.provider} disconnected`,
        });
        onUpdate();
      },
      onError: (error) => {
        toastError({
          description:
            getActionErrorMessage(error.error) ?? "Failed to disconnect",
        });
      },
    },
  );

  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span>
          {config?.name ?? channel.provider}
          {channel.teamName && (
            <span className="text-muted-foreground">
              {" "}
              &middot; {channel.teamName}
            </span>
          )}
        </span>

        {isSlackChannel && (
          <SlackNotificationTargetSelect
            emailAccountId={emailAccountId}
            messagingChannelId={channel.id}
            purpose={MessagingRoutePurpose.RULE_NOTIFICATIONS}
            targetId={channel.destinations.ruleNotifications.targetId}
            targetLabel={channel.destinations.ruleNotifications.targetLabel}
            isDm={channel.destinations.ruleNotifications.isDm}
            canSendAsDm={channel.canSendAsDm}
            onUpdate={onUpdate}
            className="h-7 w-auto gap-1 border-none bg-transparent px-1.5 text-xs text-muted-foreground shadow-none hover:bg-muted"
          />
        )}
      </div>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 hover:bg-destructive/10 hover:text-destructive"
              disabled={disconnectStatus === "executing"}
              onClick={() => executeDisconnect({ channelId: channel.id })}
            >
              <XIcon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Disconnect</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function MessagingConnectCodeDialog({
  open,
  provider,
  code,
  botUrl,
  onOpenChange,
}: {
  open: boolean;
  provider: LinkableMessagingProvider | null;
  code: string | null;
  botUrl?: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  if (!provider || !code) return null;

  const providerName = getProviderDisplayName(provider);
  const command = `/connect ${code}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {providerName}</DialogTitle>
          <DialogDescription>
            Send this command in a direct message with the Inbox Zero bot on{" "}
            {providerName}. The code is one-time use and expires in 10 minutes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Command</div>
          <CopyInput value={command} />
        </div>
        {provider === "TELEGRAM" && botUrl && (
          <div className="pt-1">
            <Button asChild size="sm">
              <a href={botUrl} target="_blank" rel="noopener noreferrer">
                Open Telegram bot
              </a>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function getProviderDisplayName(provider: LinkableMessagingProvider): string {
  if (provider === "TEAMS") return "Teams";
  return "Telegram";
}

export function useSlackNotifications(_args: {
  enabled: boolean;
  onSlackConnected?: (emailAccountId: string | null) => void;
}) {
  // Slack OAuth connect flow removed (EL-360a). This hook is now a no-op
  // kept for backward compat with existing call sites; it previously parsed
  // ?message=slack_connected redirects from /api/slack/callback.
}
