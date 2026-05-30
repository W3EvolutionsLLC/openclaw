import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded-read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

type CommandSurfaceParams = {
  ctx: {
    OriginatingChannel?: string;
    Surface?: string;
    Provider?: string;
    AccountId?: string;
  };
  command: {
    channel?: string;
  };
};

type ChannelAccountParams = {
  cfg: OpenClawConfig;
  ctx: {
    OriginatingChannel?: string;
    Surface?: string;
    Provider?: string;
    AccountId?: string;
  };
  command: {
    channel?: string;
  };
};

export function resolveConfiguredChannelDefaultAccountId(params: {
  channel: string;
  cfg: OpenClawConfig;
}): string | undefined {
  const targetChannel = normalizeOptionalLowercaseString(params.channel);
  if (!targetChannel) {
    return undefined;
  }
  let plugin: ReturnType<typeof getLoadedChannelPluginForRead>;
  try {
    plugin = getLoadedChannelPluginForRead(targetChannel);
  } catch {
    return undefined;
  }
  return normalizeOptionalString(plugin?.config.defaultAccountId?.(params.cfg));
}

export function resolveCommandSurfaceChannel(params: CommandSurfaceParams): string {
  const channel =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return normalizeOptionalLowercaseString(channel) ?? "";
}

export function resolveChannelAccountId(params: ChannelAccountParams): string {
  const accountId = normalizeOptionalString(params.ctx.AccountId) ?? "";
  if (accountId) {
    return accountId;
  }
  const channel = resolveCommandSurfaceChannel(params);
  const configuredDefault = resolveConfiguredChannelDefaultAccountId({
    channel,
    cfg: params.cfg,
  });
  return configuredDefault || "default";
}
