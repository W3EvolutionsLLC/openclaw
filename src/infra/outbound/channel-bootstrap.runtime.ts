import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimePluginRegistry } from "../../plugins/loader.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginChannelRegistryVersion,
} from "../../plugins/runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { DeliverableMessageChannel } from "../../utils/message-channel.js";

const bootstrapAttempts = new Set<string>();

export function resetOutboundChannelBootstrapStateForTests(): void {
  bootstrapAttempts.clear();
}

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function readField(value: unknown, key: string): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function readActiveChannelEntries(registry: unknown): unknown[] {
  const channels = readField(registry, "channels");
  return Array.isArray(channels) ? channels : [];
}

function channelPluginCanSend(plugin: unknown): boolean {
  const outbound = readField(plugin, "outbound");
  const outboundSendText = readField(outbound, "sendText");
  if (outboundSendText) {
    return true;
  }
  const message = readField(plugin, "message");
  const send = readField(message, "send");
  return Boolean(readField(send, "text"));
}

function findActiveChannelPlugin(registry: unknown, channel: string): unknown {
  for (const entry of readActiveChannelEntries(registry)) {
    const plugin = readField(entry, "plugin");
    const id = normalizeOptionalString(readField(plugin, "id"));
    if (id === channel) {
      return plugin;
    }
  }
  return undefined;
}

export function bootstrapOutboundChannelPlugin(params: {
  channel: DeliverableMessageChannel;
  cfg?: OpenClawConfig;
}): void {
  const cfg = params.cfg;
  if (!cfg) {
    return;
  }

  const activeChannelRegistry = getActivePluginChannelRegistry();
  const activeChannelPlugin = findActiveChannelPlugin(activeChannelRegistry, params.channel);
  if (channelPluginCanSend(activeChannelPlugin)) {
    return;
  }

  const attemptKey = `${getActivePluginChannelRegistryVersion()}:${params.channel}`;
  if (bootstrapAttempts.has(attemptKey)) {
    return;
  }
  bootstrapAttempts.add(attemptKey);

  const autoEnabled = applyPluginAutoEnable({ config: cfg });
  const defaultAgentId = resolveDefaultAgentId(autoEnabled.config);
  const workspaceDir = resolveAgentWorkspaceDir(autoEnabled.config, defaultAgentId);
  try {
    resolveRuntimePluginRegistry({
      config: autoEnabled.config,
      activationSourceConfig: cfg,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      workspaceDir,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  } catch {
    bootstrapAttempts.delete(attemptKey);
  }
}
