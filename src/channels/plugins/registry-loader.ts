import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import { getActivePluginChannelRegistry, getActivePluginRegistry } from "../../plugins/runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { ChannelId } from "./channel-id.types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

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

function readRegistryChannels(registry: unknown): unknown[] {
  const channels = readField(registry, "channels");
  return Array.isArray(channels) ? channels : [];
}

function normalizeChannelRegistration(
  entry: unknown,
): { id: string; registration: PluginChannelRegistration } | undefined {
  const plugin = readField(entry, "plugin");
  if (!isObjectLike(plugin)) {
    return undefined;
  }
  const id = normalizeOptionalString(readField(plugin, "id"));
  if (!id) {
    return undefined;
  }
  const pluginId = normalizeOptionalString(readField(entry, "pluginId")) ?? id;
  const pluginName = normalizeOptionalString(readField(entry, "pluginName"));
  const source = normalizeOptionalString(readField(entry, "source")) ?? "runtime";
  const rootDir = normalizeOptionalString(readField(entry, "rootDir"));
  return {
    id,
    registration: {
      pluginId,
      ...(pluginName ? { pluginName } : {}),
      plugin: plugin as PluginChannelRegistration["plugin"],
      source,
      ...(rootDir ? { rootDir } : {}),
    },
  };
}

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  return async (id: ChannelId): Promise<TValue | undefined> => {
    const resolveFromRegistry = (
      registry: ReturnType<typeof getActivePluginRegistry>,
    ): TValue | undefined => {
      for (const entry of readRegistryChannels(registry)) {
        const pluginEntry = normalizeChannelRegistration(entry);
        if (pluginEntry?.id !== id) {
          continue;
        }
        try {
          return resolveValue(pluginEntry.registration);
        } catch {
          return undefined;
        }
      }
      return undefined;
    };

    const channelRegistry = getActivePluginChannelRegistry();
    const channelValue = resolveFromRegistry(channelRegistry);
    if (channelValue !== undefined) {
      return channelValue;
    }

    const activeRegistry = getActivePluginRegistry();
    if (activeRegistry && activeRegistry !== channelRegistry) {
      return resolveFromRegistry(activeRegistry);
    }

    return undefined;
  };
}
