import type { PluginRegistry } from "./registry.js";
import { hasKind } from "./slots.js";

export type PluginCapabilityKind =
  | "cli-backend"
  | "text-inference"
  | "embedding"
  | "speech"
  | "realtime-transcription"
  | "realtime-voice"
  | "media-understanding"
  | "transcript-source"
  | "image-generation"
  | "video-generation"
  | "music-generation"
  | "web-search"
  | "agent-harness"
  | "context-engine"
  | "channel";

export type PluginInspectShape =
  | "hook-only"
  | "plain-capability"
  | "hybrid-capability"
  | "non-capability";

export type PluginCapabilityEntry = {
  kind: PluginCapabilityKind;
  ids: string[];
};

export type PluginShapeSummary = {
  shape: PluginInspectShape;
  capabilityMode: "none" | "plain" | "hybrid";
  capabilityCount: number;
  capabilities: PluginCapabilityEntry[];
  usesLegacyBeforeAgentStart: boolean;
};

function buildPluginCapabilityEntries(
  plugin: PluginRegistry["plugins"][number],
): PluginCapabilityEntry[] {
  const status = readPluginStringField(plugin, "status");
  const kind = readPluginKindField(plugin, "kind");
  return [
    { kind: "cli-backend" as const, ids: readPluginStringArrayField(plugin, "cliBackendIds") },
    { kind: "text-inference" as const, ids: readPluginStringArrayField(plugin, "providerIds") },
    { kind: "embedding" as const, ids: readPluginStringArrayField(plugin, "embeddingProviderIds") },
    { kind: "speech" as const, ids: readPluginStringArrayField(plugin, "speechProviderIds") },
    {
      kind: "realtime-transcription" as const,
      ids: readPluginStringArrayField(plugin, "realtimeTranscriptionProviderIds"),
    },
    {
      kind: "realtime-voice" as const,
      ids: readPluginStringArrayField(plugin, "realtimeVoiceProviderIds"),
    },
    {
      kind: "media-understanding" as const,
      ids: readPluginStringArrayField(plugin, "mediaUnderstandingProviderIds"),
    },
    {
      kind: "transcript-source" as const,
      ids: readPluginStringArrayField(plugin, "transcriptSourceProviderIds"),
    },
    {
      kind: "image-generation" as const,
      ids: readPluginStringArrayField(plugin, "imageGenerationProviderIds"),
    },
    {
      kind: "video-generation" as const,
      ids: readPluginStringArrayField(plugin, "videoGenerationProviderIds"),
    },
    {
      kind: "music-generation" as const,
      ids: readPluginStringArrayField(plugin, "musicGenerationProviderIds"),
    },
    {
      kind: "web-search" as const,
      ids: readPluginStringArrayField(plugin, "webSearchProviderIds"),
    },
    { kind: "agent-harness" as const, ids: readPluginStringArrayField(plugin, "agentHarnessIds") },
    {
      kind: "context-engine" as const,
      ids:
        status === "loaded" && hasKind(kind, "context-engine")
          ? readPluginStringArrayField(plugin, "contextEngineIds")
          : [],
    },
    { kind: "channel" as const, ids: readPluginStringArrayField(plugin, "channelIds") },
  ].filter((entry) => entry.ids.length > 0);
}

function derivePluginInspectShape(params: {
  capabilityCount: number;
  typedHookCount: number;
  customHookCount: number;
  toolCount: number;
  commandCount: number;
  cliCount: number;
  serviceCount: number;
  gatewayDiscoveryServiceCount: number;
  gatewayMethodCount: number;
  httpRouteCount: number;
}): PluginInspectShape {
  if (params.capabilityCount > 1) {
    return "hybrid-capability";
  }
  if (params.capabilityCount === 1) {
    return "plain-capability";
  }
  const hasOnlyHooks =
    params.typedHookCount + params.customHookCount > 0 &&
    params.toolCount === 0 &&
    params.commandCount === 0 &&
    params.cliCount === 0 &&
    params.serviceCount === 0 &&
    params.gatewayDiscoveryServiceCount === 0 &&
    params.gatewayMethodCount === 0 &&
    params.httpRouteCount === 0;
  if (hasOnlyHooks) {
    return "hook-only";
  }
  return "non-capability";
}

export function readRegistryRecordField(
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

export function readRegistryArrayLength(value: unknown): number | undefined {
  try {
    return Array.isArray(value) ? value.length : undefined;
  } catch {
    return undefined;
  }
}

export function readRegistryArrayElement(
  value: unknown,
  index: number,
): { ok: true; value: unknown } | { ok: false } {
  return readRegistryRecordField(value, String(index));
}

function readPluginStringField(value: unknown, field: string): string | undefined {
  const read = readRegistryRecordField(value, field);
  return read.ok && typeof read.value === "string" ? read.value : undefined;
}

function readRegistryStringArray(value: unknown): string[] | undefined {
  const length = readRegistryArrayLength(value);
  if (length === undefined) {
    return undefined;
  }
  const entries: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(value, index);
    if (entry.ok && typeof entry.value === "string") {
      entries.push(entry.value);
    }
  }
  return entries;
}

function readPluginStringArrayField(value: unknown, field: string): string[] {
  const read = readRegistryRecordField(value, field);
  return read.ok ? (readRegistryStringArray(read.value) ?? []) : [];
}

function readPluginKindField(
  value: unknown,
  field: string,
): Parameters<typeof hasKind>[0] | undefined {
  const read = readRegistryRecordField(value, field);
  if (!read.ok) {
    return undefined;
  }
  if (typeof read.value === "string") {
    return read.value as Parameters<typeof hasKind>[0];
  }
  return readRegistryStringArray(read.value) as Parameters<typeof hasKind>[0] | undefined;
}

function readPluginArrayFieldLength(value: unknown, field: string): number {
  const read = readRegistryRecordField(value, field);
  return read.ok ? (readRegistryArrayLength(read.value) ?? 0) : 0;
}

function readPluginNumberField(value: unknown, field: string): number {
  const read = readRegistryRecordField(value, field);
  return read.ok && typeof read.value === "number" ? read.value : 0;
}

export function registryEntryMatchesPluginId(entry: unknown, pluginId: string): boolean {
  const entryPluginId = readRegistryRecordField(entry, "pluginId");
  return entryPluginId.ok && entryPluginId.value === pluginId;
}

function countPluginOwnedEntries(entries: unknown, pluginId: string): number {
  const length = readRegistryArrayLength(entries);
  if (length === undefined) {
    return 0;
  }
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(entries, index);
    if (entry.ok && registryEntryMatchesPluginId(entry.value, pluginId)) {
      count += 1;
    }
  }
  return count;
}

export function listPluginOwnedGatewayMethodNames(params: {
  descriptors: unknown;
  pluginId: string;
}): string[] {
  const length = readRegistryArrayLength(params.descriptors);
  if (length === undefined) {
    return [];
  }
  const names: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = readRegistryArrayElement(params.descriptors, index);
    if (!descriptor.ok) {
      continue;
    }
    const owner = readRegistryRecordField(descriptor.value, "owner");
    if (!owner.ok) {
      continue;
    }
    const ownerKind = readRegistryRecordField(owner.value, "kind");
    if (!ownerKind.ok || ownerKind.value !== "plugin") {
      continue;
    }
    const ownerPluginId = readRegistryRecordField(owner.value, "pluginId");
    if (!ownerPluginId.ok || ownerPluginId.value !== params.pluginId) {
      continue;
    }
    const name = readRegistryRecordField(descriptor.value, "name");
    if (name.ok && typeof name.value === "string") {
      names.push(name.value);
    }
  }
  return names;
}

export function buildPluginShapeSummary(params: {
  plugin: PluginRegistry["plugins"][number];
  report: Pick<PluginRegistry, "hooks" | "typedHooks" | "tools" | "gatewayMethodDescriptors">;
}): PluginShapeSummary {
  const pluginId = readPluginStringField(params.plugin, "id") ?? "";
  const capabilities = buildPluginCapabilityEntries(params.plugin);
  const typedHookCount = countPluginOwnedEntries(params.report.typedHooks, pluginId);
  const customHookCount = countPluginOwnedEntries(params.report.hooks, pluginId);
  const toolCount = countPluginOwnedEntries(params.report.tools, pluginId);
  const gatewayMethodCount = listPluginOwnedGatewayMethodNames({
    descriptors: params.report.gatewayMethodDescriptors,
    pluginId,
  }).length;
  const capabilityCount = capabilities.length;
  const shape = derivePluginInspectShape({
    capabilityCount,
    typedHookCount,
    customHookCount,
    toolCount,
    commandCount: readPluginArrayFieldLength(params.plugin, "commands"),
    cliCount: readPluginArrayFieldLength(params.plugin, "cliCommands"),
    serviceCount: readPluginArrayFieldLength(params.plugin, "services"),
    gatewayDiscoveryServiceCount: readPluginArrayFieldLength(
      params.plugin,
      "gatewayDiscoveryServiceIds",
    ),
    gatewayMethodCount,
    httpRouteCount: readPluginNumberField(params.plugin, "httpRoutes"),
  });

  return {
    shape,
    capabilityMode: capabilityCount === 0 ? "none" : capabilityCount === 1 ? "plain" : "hybrid",
    capabilityCount,
    capabilities,
    usesLegacyBeforeAgentStart: hasPluginOwnedLegacyBeforeAgentStartHook({
      typedHooks: params.report.typedHooks,
      pluginId,
    }),
  };
}

function hasPluginOwnedLegacyBeforeAgentStartHook(params: {
  typedHooks: unknown;
  pluginId: string;
}): boolean {
  const length = readRegistryArrayLength(params.typedHooks);
  if (length === undefined) {
    return false;
  }
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(params.typedHooks, index);
    if (!entry.ok || !registryEntryMatchesPluginId(entry.value, params.pluginId)) {
      continue;
    }
    const hookName = readRegistryRecordField(entry.value, "hookName");
    if (hookName.ok && hookName.value === "before_agent_start") {
      return true;
    }
  }
  return false;
}
