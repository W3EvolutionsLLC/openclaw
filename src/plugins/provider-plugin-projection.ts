import { normalizeStringEntries } from "../shared/string-normalization.js";
import type { ProviderPlugin } from "./types.js";

function readProviderPluginStringField(
  provider: ProviderPlugin,
  field: "id" | "label",
): string | undefined {
  try {
    const value = provider[field];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readProviderPluginStringList(
  provider: ProviderPlugin,
  field: "aliases" | "hookAliases",
): { values: string[]; shouldMask: boolean } {
  try {
    const value = provider[field];
    if (value === undefined) {
      return { values: [], shouldMask: false };
    }
    if (!Array.isArray(value)) {
      return { values: [], shouldMask: true };
    }
    return { values: normalizeStringEntries(value), shouldMask: true };
  } catch {
    return { values: [], shouldMask: true };
  }
}

function readProviderPluginAuth(provider: ProviderPlugin): ProviderPlugin["auth"] | undefined {
  try {
    return Array.isArray(provider.auth) ? provider.auth : undefined;
  } catch {
    return undefined;
  }
}

function copyReadableProviderFields(provider: ProviderPlugin): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(provider);
  } catch {
    return fields;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !descriptor.enumerable ||
      key === "id" ||
      key === "label" ||
      key === "auth" ||
      key === "aliases" ||
      key === "hookAliases" ||
      key === "pluginId"
    ) {
      continue;
    }
    try {
      fields[key] = (provider as Record<string, unknown>)[key];
    } catch {
      // Unreadable plugin-owned provider fields are treated as absent.
    }
  }
  return fields;
}

export function createProviderRuntimeProjection(entry: {
  pluginId: string;
  provider: ProviderPlugin;
}): ProviderPlugin | undefined {
  const id = readProviderPluginStringField(entry.provider, "id");
  if (!id) {
    return undefined;
  }
  const label = readProviderPluginStringField(entry.provider, "label");
  const auth = readProviderPluginAuth(entry.provider);
  if (!label || !auth) {
    return undefined;
  }
  const aliases = readProviderPluginStringList(entry.provider, "aliases");
  const hookAliases = readProviderPluginStringList(entry.provider, "hookAliases");
  return {
    ...copyReadableProviderFields(entry.provider),
    id,
    label,
    auth,
    ...(aliases.shouldMask ? { aliases: aliases.values } : {}),
    ...(hookAliases.shouldMask ? { hookAliases: hookAliases.values } : {}),
    pluginId: entry.pluginId,
  } as ProviderPlugin;
}
