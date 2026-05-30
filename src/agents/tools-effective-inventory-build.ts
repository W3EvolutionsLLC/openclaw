import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { buildPluginToolMetadataKey, getPluginToolMeta } from "../plugins/tools.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { getChannelAgentToolMeta } from "./channel-tools.js";
import { normalizeAgentRuntimeTools } from "./runtime-plan/tools.js";
import { summarizeToolDescriptionText } from "./tool-description-summary.js";
import { resolveToolDisplay } from "./tool-display.js";
import {
  filterRuntimeCompatibleTools,
  type RuntimeToolSchemaDiagnostic,
} from "./tool-schema-projection.js";
import { buildEffectiveToolInventoryGroups } from "./tools-effective-inventory-groups.js";
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryNotice,
  EffectiveToolSource,
} from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

type InventoryToolMetadata = {
  displayName?: string;
  description?: string;
  risk?: "low" | "medium" | "high";
  tags?: string[];
};

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

function readArrayFieldElements(value: unknown, field: string): unknown[] {
  const read = readRecordField(value, field);
  if (!read.ok) {
    return [];
  }
  const length = readArrayLength(read.value);
  if (length === undefined) {
    return [];
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readArrayElement(read.value, index);
    if (entry.ok) {
      entries.push(entry.value);
    }
  }
  return entries;
}

function readNormalizedStringField(value: unknown, field: string): string | undefined {
  const read = readRecordField(value, field);
  if (!read.ok || typeof read.value !== "string") {
    return undefined;
  }
  return normalizeOptionalString(read.value);
}

function readStringField(value: unknown, field: string): string | undefined {
  const read = readRecordField(value, field);
  return read.ok && typeof read.value === "string" ? read.value : undefined;
}

function readStringArrayField(value: unknown, field: string): string[] | undefined {
  const read = readRecordField(value, field);
  if (!read.ok) {
    return undefined;
  }
  const length = readArrayLength(read.value);
  if (length === undefined) {
    return undefined;
  }
  const items: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = readArrayElement(read.value, index);
    if (!item.ok || typeof item.value !== "string") {
      continue;
    }
    const normalized = normalizeOptionalString(item.value);
    if (normalized) {
      items.push(normalized);
    }
  }
  return items.length > 0 ? items : undefined;
}

function readInventoryToolField(
  tool: AnyAgentTool,
  key: "name" | "label" | "description" | "displaySummary",
): unknown {
  try {
    return (tool as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function readInventoryToolName(tool: AnyAgentTool): string | undefined {
  return normalizeOptionalString(readInventoryToolField(tool, "name"));
}

function readInventoryToolString(
  tool: AnyAgentTool,
  key: "label" | "description" | "displaySummary",
): string | undefined {
  const value = readInventoryToolField(tool, key);
  return typeof value === "string" ? value : undefined;
}

function buildReadableToolNameMap(tools: readonly AnyAgentTool[]): Map<string, AnyAgentTool> {
  const byName = new Map<string, AnyAgentTool>();
  for (const tool of tools) {
    const name = readInventoryToolName(tool);
    if (name) {
      byName.set(name, tool);
    }
  }
  return byName;
}

function resolveEffectiveToolLabel(tool: AnyAgentTool, toolName: string): string {
  const rawLabel = normalizeOptionalString(readInventoryToolString(tool, "label")) ?? "";
  if (
    rawLabel &&
    normalizeLowercaseStringOrEmpty(rawLabel) !== normalizeLowercaseStringOrEmpty(toolName)
  ) {
    return rawLabel;
  }
  return resolveToolDisplay({ name: toolName }).title;
}

function resolveRawToolDescription(tool: AnyAgentTool): string {
  return normalizeOptionalString(readInventoryToolString(tool, "description")) ?? "";
}

function summarizeToolDescription(tool: AnyAgentTool): string {
  return summarizeToolDescriptionText({
    rawDescription: resolveRawToolDescription(tool),
    displaySummary: readInventoryToolString(tool, "displaySummary"),
  });
}

function resolveEffectiveToolSource(
  tool: AnyAgentTool,
  fallbackTool?: AnyAgentTool,
): {
  source: EffectiveToolSource;
  pluginId?: string;
  channelId?: string;
} {
  const pluginMeta =
    getPluginToolMeta(tool) ?? (fallbackTool ? getPluginToolMeta(fallbackTool) : undefined);
  if (pluginMeta) {
    if (pluginMeta.pluginId === "bundle-mcp") {
      return { source: "mcp", pluginId: pluginMeta.pluginId };
    }
    return { source: "plugin", pluginId: pluginMeta.pluginId };
  }
  const channelMeta =
    getChannelAgentToolMeta(tool as never) ??
    (fallbackTool ? getChannelAgentToolMeta(fallbackTool as never) : undefined);
  if (channelMeta) {
    return { source: "channel", channelId: channelMeta.channelId };
  }
  return { source: "core" };
}

function buildUnsupportedToolSchemaNotice(params: {
  diagnostic: RuntimeToolSchemaDiagnostic;
  tool: AnyAgentTool | undefined;
  fallbackTool: AnyAgentTool | undefined;
}): EffectiveToolInventoryNotice {
  const source = params.tool
    ? resolveEffectiveToolSource(params.tool, params.fallbackTool)
    : { source: "core" as const };
  const owner =
    source.source === "plugin" && source.pluginId
      ? ` from plugin "${source.pluginId}"`
      : source.source === "channel" && source.channelId
        ? ` from channel "${source.channelId}"`
        : "";
  return {
    id: `unsupported-tool-schema:${params.diagnostic.toolName}`,
    severity: "warning",
    message: `Tool "${params.diagnostic.toolName}"${owner} has an unsupported runtime input schema (${params.diagnostic.violations.join(", ")}) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.`,
  };
}

function buildUnsupportedToolSchemaNotices(params: {
  diagnostics: readonly RuntimeToolSchemaDiagnostic[];
  tools: readonly AnyAgentTool[];
  rawToolsByName: ReadonlyMap<string, AnyAgentTool>;
}): EffectiveToolInventoryNotice[] {
  return params.diagnostics.map((diagnostic) =>
    buildUnsupportedToolSchemaNotice({
      diagnostic,
      tool: params.tools[diagnostic.toolIndex],
      fallbackTool: params.rawToolsByName.get(diagnostic.toolName),
    }),
  );
}

function readActivePluginToolMetadata(): Map<string, InventoryToolMetadata> {
  const metadata = new Map<string, InventoryToolMetadata>();
  for (const entry of readArrayFieldElements(getActivePluginRegistry(), "toolMetadata")) {
    const pluginId = readNormalizedStringField(entry, "pluginId");
    const metadataRecord = readRecordField(entry, "metadata");
    if (!pluginId || !metadataRecord.ok) {
      continue;
    }
    const toolName = readNormalizedStringField(metadataRecord.value, "toolName");
    if (!toolName) {
      continue;
    }
    const displayName = readStringField(metadataRecord.value, "displayName");
    const description = readStringField(metadataRecord.value, "description");
    const risk = readStringField(metadataRecord.value, "risk");
    const tags = readStringArrayField(metadataRecord.value, "tags");
    metadata.set(buildPluginToolMetadataKey(pluginId, toolName), {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(risk === "low" || risk === "medium" || risk === "high" ? { risk } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });
  }
  return metadata;
}

function disambiguateLabels(entries: EffectiveToolInventoryEntry[]): EffectiveToolInventoryEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if ((counts.get(entry.label) ?? 0) < 2) {
      return entry;
    }
    const suffix = entry.pluginId ?? entry.channelId ?? entry.id;
    return { ...entry, label: `${entry.label} (${suffix})` };
  });
}

export function buildEffectiveToolInventoryEntries(
  tools: readonly AnyAgentTool[],
  rawToolsByName: ReadonlyMap<string, AnyAgentTool> = new Map(),
): EffectiveToolInventoryEntry[] {
  // Key metadata by plugin ownership and tool name so only the owning plugin can
  // project display/risk metadata for its own tool.
  const pluginToolMetadata = readActivePluginToolMetadata();

  return disambiguateLabels(
    tools
      .flatMap((tool) => {
        const toolName = readInventoryToolName(tool);
        if (!toolName) {
          return [];
        }
        const source = resolveEffectiveToolSource(tool, rawToolsByName.get(toolName));
        const metadata = source.pluginId
          ? pluginToolMetadata.get(buildPluginToolMetadataKey(source.pluginId, toolName))
          : undefined;
        return [
          Object.assign(
            {
              id: toolName,
              label:
                normalizeOptionalString(metadata?.displayName) ??
                resolveEffectiveToolLabel(tool, toolName),
              description:
                normalizeOptionalString(metadata?.description) ?? summarizeToolDescription(tool),
              rawDescription:
                normalizeOptionalString(metadata?.description) ??
                resolveRawToolDescription(tool) ??
                summarizeToolDescription(tool),
              ...(metadata?.risk ? { risk: metadata.risk } : {}),
              ...(metadata?.tags ? { tags: metadata.tags } : {}),
            },
            source,
          ) satisfies EffectiveToolInventoryEntry,
        ];
      })
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  );
}

export function buildRuntimeCompatibleToolInventory(params: {
  tools: readonly AnyAgentTool[];
  cfg: OpenClawConfig;
  workspaceDir?: string;
  modelProvider?: string;
  modelId?: string;
  modelApi?: string | null;
  runtimeModel?: ProviderRuntimeModel;
}): {
  entries: EffectiveToolInventoryEntry[];
  notices: EffectiveToolInventoryNotice[];
} {
  const rawToolsByName = buildReadableToolNameMap(params.tools);
  const normalizedTools = normalizeAgentRuntimeTools({
    // Schema normalization can replace tool definitions, so hand the runtime
    // policy a mutable copy while keeping this inventory API readonly.
    tools: [...params.tools],
    provider: params.modelProvider ?? "",
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    modelId: params.modelId,
    modelApi: params.modelApi ?? undefined,
    model: params.runtimeModel,
  });
  const projection = filterRuntimeCompatibleTools(normalizedTools);
  return {
    entries: buildEffectiveToolInventoryEntries(projection.tools, rawToolsByName),
    notices: buildUnsupportedToolSchemaNotices({
      diagnostics: projection.diagnostics,
      tools: normalizedTools,
      rawToolsByName,
    }),
  };
}

export { buildEffectiveToolInventoryGroups };
