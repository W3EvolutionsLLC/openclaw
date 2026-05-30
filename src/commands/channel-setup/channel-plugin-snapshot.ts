import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

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

function readArrayLength(value: unknown): number | undefined {
  try {
    return Array.isArray(value) ? value.length : undefined;
  } catch {
    return undefined;
  }
}

function readArrayElement(value: unknown, index: number): unknown {
  return readField(value, String(index));
}

export function findChannelPluginInSnapshotEntries(
  entries: unknown,
  channelId: string,
): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(channelId) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  const entryCount = readArrayLength(entries);
  if (entryCount === undefined) {
    return undefined;
  }
  for (let index = 0; index < entryCount; index += 1) {
    const plugin = readField(readArrayElement(entries, index), "plugin");
    const id = normalizeOptionalString(readField(plugin, "id"));
    if (id === resolvedId) {
      return plugin as ChannelPlugin;
    }
  }
  return undefined;
}

export function findChannelPluginInSnapshot(
  snapshot: unknown,
  field: "channels" | "channelSetups",
  channelId: string,
): ChannelPlugin | undefined {
  return findChannelPluginInSnapshotEntries(readField(snapshot, field), channelId);
}
