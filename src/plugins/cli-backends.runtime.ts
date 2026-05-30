import { getActiveRuntimePluginRegistry } from "./active-runtime-registry.js";
import type { CliBackendPlugin } from "./cli-backend.types.js";

export type PluginCliBackendEntry = CliBackendPlugin & {
  pluginId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readCliBackendId(backend: CliBackendPlugin): string | undefined {
  try {
    return readNonEmptyString(backend.id);
  } catch {
    return undefined;
  }
}

function copyReadableRecordFields(record: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(record);
  } catch {
    return fields;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) {
      continue;
    }
    try {
      fields[key] = record[key];
    } catch {
      // Unreadable plugin-owned fields are treated as absent.
    }
  }
  return fields;
}

function readCliBackendConfig(backend: CliBackendPlugin): CliBackendPlugin["config"] | undefined {
  try {
    const config = backend.config;
    if (!isRecord(config)) {
      return undefined;
    }
    const fields = copyReadableRecordFields(config);
    const command = readNonEmptyString(fields.command);
    return command ? ({ ...fields, command } as CliBackendPlugin["config"]) : undefined;
  } catch {
    return undefined;
  }
}

function copyReadableCliBackendFields(backend: CliBackendPlugin): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(backend);
  } catch {
    return fields;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || key === "id" || key === "config" || key === "pluginId") {
      continue;
    }
    try {
      fields[key] = (backend as Record<string, unknown>)[key];
    } catch {
      // Unreadable plugin-owned CLI backend fields are treated as absent.
    }
  }
  return fields;
}

function createRuntimeCliBackendEntry(entry: {
  pluginId: string;
  backend: CliBackendPlugin;
}): PluginCliBackendEntry | undefined {
  const id = readCliBackendId(entry.backend);
  const config = readCliBackendConfig(entry.backend);
  if (!id || !config) {
    return undefined;
  }
  return {
    ...copyReadableCliBackendFields(entry.backend),
    id,
    config,
    pluginId: entry.pluginId,
  } as PluginCliBackendEntry;
}

export function resolveRuntimeCliBackends(): PluginCliBackendEntry[] {
  return (getActiveRuntimePluginRegistry()?.cliBackends ?? []).flatMap((entry) => {
    const backend = createRuntimeCliBackendEntry(entry);
    return backend ? [backend] : [];
  });
}
