import type {
  ActivePluginChannelRegistration,
  ActivePluginChannelRegistry,
} from "../plugins/channel-registry-state.types.js";
import { getActivePluginChannelRegistrySnapshotFromState } from "../plugins/runtime-channel-state.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export type RegisteredChannelPluginEntry = ActivePluginChannelRegistration & {
  plugin: {
    id: string;
    meta?: {
      aliases?: readonly string[];
      markdownCapable?: boolean;
    } | null;
  };
};

type RegisteredChannelPluginLookup = {
  registry: ActivePluginChannelRegistry | null;
  channels: ActivePluginChannelRegistration[] | undefined;
  channelCount: number;
  version: number;
  entries: RegisteredChannelPluginEntry[];
  byKey: Map<string, RegisteredChannelPluginEntry>;
  byId: Map<string, RegisteredChannelPluginEntry>;
};

let registeredChannelPluginLookup: RegisteredChannelPluginLookup | undefined;

function readRecordField(
  value: unknown,
  field: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      return { ok: false };
    }
    return { ok: true, value: (value as Record<string, unknown>)[field] };
  } catch {
    return { ok: false };
  }
}

function readArrayLength(value: unknown): number | undefined {
  try {
    return Array.isArray(value) ? value.length : undefined;
  } catch {
    return undefined;
  }
}

function readArrayElement(
  value: unknown,
  index: number,
): { ok: true; value: unknown } | { ok: false } {
  return readRecordField(value, String(index));
}

function readStringArray(value: unknown): string[] | undefined {
  const length = readArrayLength(value);
  if (length === undefined) {
    return undefined;
  }
  const entries: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readArrayElement(value, index);
    if (!entry.ok || typeof entry.value !== "string") {
      continue;
    }
    const normalized = normalizeOptionalString(entry.value);
    if (normalized) {
      entries.push(normalized);
    }
  }
  return entries;
}

function readStringField(value: unknown, field: string): string | undefined {
  const read = readRecordField(value, field);
  return read.ok && typeof read.value === "string" ? read.value : undefined;
}

function readBooleanField(value: unknown, field: string): boolean | undefined {
  const read = readRecordField(value, field);
  return read.ok && typeof read.value === "boolean" ? read.value : undefined;
}

function readChannelRegistryEntries(registry: ActivePluginChannelRegistry | null): {
  channels: ActivePluginChannelRegistration[] | undefined;
  entries: RegisteredChannelPluginEntry[];
  channelCount: number;
} {
  const channelsRead = readRecordField(registry, "channels");
  if (!channelsRead.ok) {
    return { channels: undefined, entries: [], channelCount: 0 };
  }
  const channelCount = readArrayLength(channelsRead.value);
  if (channelCount === undefined) {
    return { channels: undefined, entries: [], channelCount: 0 };
  }
  const entries: RegisteredChannelPluginEntry[] = [];
  for (let index = 0; index < channelCount; index += 1) {
    const entry = readArrayElement(channelsRead.value, index);
    const plugin = entry.ok ? readRecordField(entry.value, "plugin") : ({ ok: false } as const);
    const id = plugin.ok ? normalizeOptionalString(readStringField(plugin.value, "id")) : undefined;
    if (!entry.ok || !plugin.ok || !id) {
      continue;
    }
    const meta = readRecordField(plugin.value, "meta");
    const aliasesRead = meta.ok ? readRecordField(meta.value, "aliases") : undefined;
    const aliases = aliasesRead?.ok ? readStringArray(aliasesRead.value) : undefined;
    const markdownCapable = meta.ok ? readBooleanField(meta.value, "markdownCapable") : undefined;
    entries.push({
      pluginId: id,
      source: "registry",
      plugin: {
        id,
        meta: {
          ...(aliases !== undefined ? { aliases } : {}),
          ...(markdownCapable !== undefined ? { markdownCapable } : {}),
        },
      },
    } as RegisteredChannelPluginEntry);
  }
  return {
    channels: channelsRead.value as ActivePluginChannelRegistration[],
    entries,
    channelCount,
  };
}

function setLookupEntry(
  map: Map<string, RegisteredChannelPluginEntry>,
  key: string | undefined,
  entry: RegisteredChannelPluginEntry,
): void {
  if (key && !map.has(key)) {
    map.set(key, entry);
  }
}

function buildRegisteredChannelPluginLookup(): RegisteredChannelPluginLookup {
  const { registry, version } = getActivePluginChannelRegistrySnapshotFromState();
  const { channels, entries, channelCount } = readChannelRegistryEntries(registry);
  const cached = registeredChannelPluginLookup;
  if (
    cached &&
    cached.registry === registry &&
    cached.channels === channels &&
    cached.channelCount === channelCount &&
    cached.version === version
  ) {
    return cached;
  }
  const byKey = new Map<string, RegisteredChannelPluginEntry>();
  const byId = new Map<string, RegisteredChannelPluginEntry>();
  for (const entry of entries) {
    const id = normalizeOptionalLowercaseString(entry.plugin.id);
    setLookupEntry(byKey, id, entry);
    setLookupEntry(byId, id, entry);
    for (const alias of entry.plugin.meta?.aliases ?? []) {
      setLookupEntry(byKey, normalizeOptionalLowercaseString(alias), entry);
    }
  }
  registeredChannelPluginLookup = {
    registry,
    channels,
    channelCount,
    version,
    entries,
    byKey,
    byId,
  };
  return registeredChannelPluginLookup;
}

export function listRegisteredChannelPluginEntries(): RegisteredChannelPluginEntry[] {
  return buildRegisteredChannelPluginLookup().entries;
}

export function findRegisteredChannelPluginEntry(
  normalizedKey: string,
): RegisteredChannelPluginEntry | undefined {
  return buildRegisteredChannelPluginLookup().byKey.get(normalizedKey);
}

export function findRegisteredChannelPluginEntryById(
  id: string,
): RegisteredChannelPluginEntry | undefined {
  const normalizedId = normalizeOptionalLowercaseString(id);
  if (!normalizedId) {
    return undefined;
  }
  return buildRegisteredChannelPluginLookup().byId.get(normalizedId);
}
