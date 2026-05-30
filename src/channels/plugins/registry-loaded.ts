import type {
  ActiveChannelPluginRuntimeShape,
  ActivePluginChannelRegistration,
} from "../../plugins/channel-registry-state.types.js";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CHAT_CHANNEL_ORDER } from "../registry.js";

export type LoadedChannelPlugin = ActiveChannelPluginRuntimeShape & {
  id: string;
  meta: NonNullable<ActiveChannelPluginRuntimeShape["meta"]>;
};

export type LoadedChannelPluginEntry = ActivePluginChannelRegistration & {
  plugin: LoadedChannelPlugin;
};

type ChannelPluginView = {
  sorted: LoadedChannelPlugin[];
  byId: Map<string, LoadedChannelPlugin>;
  entriesById: Map<string, LoadedChannelPluginEntry>;
};

type LoadedChannelPluginRecord = {
  id: string;
  order?: number;
  plugin: LoadedChannelPlugin;
  entry: LoadedChannelPluginEntry;
};

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

function ensureReadablePluginMeta(plugin: Record<PropertyKey, unknown>): boolean {
  const meta = readField(plugin, "meta");
  if (isObjectLike(meta)) {
    return true;
  }
  try {
    plugin.meta = {};
    return true;
  } catch {
    return false;
  }
}

function readPluginOrder(plugin: LoadedChannelPlugin): number | undefined {
  const meta = readField(plugin, "meta");
  const order = isObjectLike(meta) ? readField(meta, "order") : undefined;
  return typeof order === "number" && Number.isFinite(order) ? order : undefined;
}

function coerceLoadedChannelPlugin(plugin: unknown): LoadedChannelPlugin | null {
  if (!isObjectLike(plugin)) {
    return null;
  }
  const id = normalizeOptionalString(readField(plugin, "id")) ?? "";
  if (!id || !ensureReadablePluginMeta(plugin)) {
    return null;
  }
  return plugin as LoadedChannelPlugin;
}

function coerceLoadedChannelPluginRecord(entry: unknown): LoadedChannelPluginRecord | null {
  const plugin = coerceLoadedChannelPlugin(readField(entry, "plugin"));
  if (!plugin) {
    return null;
  }
  const id = normalizeOptionalString(readField(plugin, "id")) ?? "";
  if (!id) {
    return null;
  }
  const pluginId = normalizeOptionalString(readField(entry, "pluginId"));
  const origin = normalizeOptionalString(readField(entry, "origin"));
  const registration = {
    ...(pluginId ? { pluginId } : {}),
    ...(origin ? { origin } : {}),
    plugin,
  } as LoadedChannelPluginEntry;
  return {
    id,
    order: readPluginOrder(plugin),
    plugin,
    entry: registration,
  };
}

function dedupeChannels(channels: LoadedChannelPluginRecord[]): LoadedChannelPluginRecord[] {
  const seen = new Set<string>();
  const resolved: LoadedChannelPluginRecord[] = [];
  for (const record of channels) {
    if (seen.has(record.id)) {
      continue;
    }
    seen.add(record.id);
    resolved.push(record);
  }
  return resolved;
}

function resolveChannelPlugins(): ChannelPluginView {
  const registry = getActivePluginChannelRegistryFromState();

  const channelPlugins: LoadedChannelPluginRecord[] = [];
  for (const entry of readRegistryChannels(registry)) {
    const record = coerceLoadedChannelPluginRecord(entry);
    if (record) {
      channelPlugins.push(record);
    }
  }

  const sorted = dedupeChannels(channelPlugins).toSorted((a, b) => {
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
    const orderA = a.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });
  const byId = new Map<string, LoadedChannelPlugin>();
  const entriesById = new Map<string, LoadedChannelPluginEntry>();
  for (const record of sorted) {
    byId.set(record.id, record.plugin);
    entriesById.set(record.id, record.entry);
  }

  return {
    sorted: sorted.map((entry) => entry.plugin),
    byId,
    entriesById,
  };
}

export function listLoadedChannelPlugins(): LoadedChannelPlugin[] {
  return resolveChannelPlugins().sorted.slice();
}

export function getLoadedChannelPluginById(id: string): LoadedChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().byId.get(resolvedId);
}

export function getLoadedChannelPluginEntryById(id: string): LoadedChannelPluginEntry | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().entriesById.get(resolvedId);
}
