import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type ToolsCatalogResult,
  validateToolsCatalogParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  listCoreToolSections,
  PROFILE_OPTIONS,
  resolveCoreToolProfiles,
} from "../../agents/tool-catalog.js";
import { summarizeToolDescriptionText } from "../../agents/tool-description-summary.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  buildPluginToolMetadataKey,
  ensureStandalonePluginToolRegistryLoaded,
  getPluginToolMeta,
  resolvePluginTools,
} from "../../plugins/tools.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type ToolCatalogEntry = {
  id: string;
  label: string;
  description: string;
  source: "core" | "plugin";
  pluginId?: string;
  optional?: boolean;
  risk?: "low" | "medium" | "high";
  tags?: string[];
  defaultProfiles: Array<"minimal" | "coding" | "messaging" | "full">;
};

type ToolCatalogGroup = {
  id: string;
  label: string;
  source: "core" | "plugin";
  pluginId?: string;
  tools: ToolCatalogEntry[];
};

function readPluginCatalogToolField(
  tool: unknown,
  key: "name" | "label" | "description" | "displaySummary",
): unknown {
  const read = readRecordField(tool, key);
  return read.ok ? read.value : undefined;
}

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

function readBooleanField(value: unknown, field: string): boolean | undefined {
  const read = readRecordField(value, field);
  return read.ok && typeof read.value === "boolean" ? read.value : undefined;
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

function readPluginCatalogToolName(tool: unknown): string | undefined {
  const value = readPluginCatalogToolField(tool, "name");
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function readPluginCatalogToolString(
  tool: unknown,
  key: "label" | "description" | "displaySummary",
): string | undefined {
  const value = readPluginCatalogToolField(tool, key);
  return typeof value === "string" ? value : undefined;
}

type PluginCatalogMetadata = {
  displayName?: string;
  description?: string;
  risk?: "low" | "medium" | "high";
  tags?: string[];
};

function readPluginCatalogMetadata(activeRegistry: unknown): Map<string, PluginCatalogMetadata> {
  const metadata = new Map<string, PluginCatalogMetadata>();
  for (const entry of readArrayFieldElements(activeRegistry, "toolMetadata")) {
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

function resolveAgentIdOrRespondError(
  rawAgentId: unknown,
  respond: RespondFn,
  cfg: OpenClawConfig,
) {
  const knownAgents = listAgentIds(cfg);
  const requestedAgentId = normalizeOptionalString(rawAgentId) ?? "";
  const agentId = requestedAgentId || resolveDefaultAgentId(cfg);
  if (requestedAgentId && !knownAgents.includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { cfg, agentId };
}

function buildCoreGroups(): ToolCatalogGroup[] {
  return listCoreToolSections().map((section) => ({
    id: section.id,
    label: section.label,
    source: "core",
    tools: section.tools.map((tool) => ({
      id: tool.id,
      label: tool.label,
      description: tool.description,
      source: "core",
      defaultProfiles: resolveCoreToolProfiles(tool.id),
    })),
  }));
}

function buildPluginGroups(params: {
  cfg: OpenClawConfig;
  agentId: string;
  existingToolNames: Set<string>;
}): ToolCatalogGroup[] {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  const toolContext = {
    config: params.cfg,
    workspaceDir,
    agentDir,
    agentId: params.agentId,
  };
  ensureStandalonePluginToolRegistryLoaded({
    context: toolContext,
    toolAllowlist: ["group:plugins"],
    allowGatewaySubagentBinding: true,
  });
  const pluginTools = resolvePluginTools({
    context: toolContext,
    existingToolNames: params.existingToolNames,
    toolAllowlist: ["group:plugins"],
    suppressNameConflicts: true,
    allowGatewaySubagentBinding: true,
  });
  const activeRegistry = getActivePluginRegistry();
  const groups = new Map<string, ToolCatalogGroup>();
  // Key metadata by plugin ownership and tool name so we only project metadata that
  // was registered BY the tool's owning plugin. Without this scoping, plugin-X
  // could override the catalog label/description/risk/tags for another plugin's
  // tool by registering metadata with the same toolName.
  const pluginToolMetadata = readPluginCatalogMetadata(activeRegistry);
  const seenToolIds = new Set<string>();
  for (const tool of pluginTools) {
    const toolName = readPluginCatalogToolName(tool);
    if (!toolName) {
      continue;
    }
    const meta = getPluginToolMeta(tool);
    const pluginId = meta?.pluginId ?? "plugin";
    const groupId = `plugin:${pluginId}`;
    const existing =
      groups.get(groupId) ??
      ({
        id: groupId,
        label: pluginId,
        source: "plugin",
        pluginId,
        tools: [],
      } as ToolCatalogGroup);
    const ownedMetadata = meta?.pluginId
      ? pluginToolMetadata.get(buildPluginToolMetadataKey(meta.pluginId, toolName))
      : undefined;
    const toolLabel = readPluginCatalogToolString(tool, "label");
    const toolDescription = readPluginCatalogToolString(tool, "description");
    const toolDisplaySummary = readPluginCatalogToolString(tool, "displaySummary");
    existing.tools.push({
      id: toolName,
      label:
        normalizeOptionalString(ownedMetadata?.displayName) ??
        normalizeOptionalString(toolLabel) ??
        toolName,
      description: summarizeToolDescriptionText({
        rawDescription: ownedMetadata?.description ?? toolDescription,
        displaySummary: toolDisplaySummary,
      }),
      source: "plugin",
      pluginId,
      optional: meta?.optional,
      risk: ownedMetadata?.risk,
      tags: ownedMetadata?.tags,
      defaultProfiles: [],
    });
    seenToolIds.add(toolName);
    groups.set(groupId, existing);
  }
  for (const entry of readArrayFieldElements(activeRegistry, "tools")) {
    const pluginId = readNormalizedStringField(entry, "pluginId");
    if (!pluginId) {
      continue;
    }
    const pluginName = readStringField(entry, "pluginName") ?? pluginId;
    const names =
      readStringArrayField(entry, "names") ?? readStringArrayField(entry, "declaredNames") ?? [];
    for (const name of names) {
      if (seenToolIds.has(name) || params.existingToolNames.has(name)) {
        continue;
      }
      const groupId = `plugin:${pluginId}`;
      const existing =
        groups.get(groupId) ??
        ({
          id: groupId,
          label: pluginName,
          source: "plugin",
          pluginId,
          tools: [],
        } as ToolCatalogGroup);
      const ownedMetadata = pluginToolMetadata.get(buildPluginToolMetadataKey(pluginId, name));
      existing.tools.push({
        id: name,
        label: normalizeOptionalString(ownedMetadata?.displayName) ?? name,
        description:
          summarizeToolDescriptionText({
            rawDescription: ownedMetadata?.description,
          }) || `Plugin tool from ${pluginName}`,
        source: "plugin",
        pluginId,
        optional: readBooleanField(entry, "optional"),
        risk: ownedMetadata?.risk,
        tags: ownedMetadata?.tags,
        defaultProfiles: [],
      });
      seenToolIds.add(name);
      groups.set(groupId, existing);
    }
  }
  return [...groups.values()]
    .map((group) =>
      Object.assign({}, group, { tools: group.tools.toSorted((a, b) => a.id.localeCompare(b.id)) }),
    )
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export function buildToolsCatalogResult(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  includePlugins?: boolean;
}): ToolsCatalogResult {
  const agentId = normalizeOptionalString(params.agentId) || resolveDefaultAgentId(params.cfg);
  const includePlugins = params.includePlugins !== false;
  const groups = buildCoreGroups();
  if (includePlugins) {
    const existingToolNames = new Set(
      groups.flatMap((group) => group.tools.map((tool) => tool.id)),
    );
    groups.push(
      ...buildPluginGroups({
        cfg: params.cfg,
        agentId,
        existingToolNames,
      }),
    );
  }
  return {
    agentId,
    profiles: PROFILE_OPTIONS.map((profile) => ({ id: profile.id, label: profile.label })),
    groups,
  };
}

export const toolsCatalogHandlers: GatewayRequestHandlers = {
  "tools.catalog": ({ params, respond, context }) => {
    if (!validateToolsCatalogParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.catalog params: ${formatValidationErrors(validateToolsCatalogParams.errors)}`,
        ),
      );
      return;
    }
    const resolved = resolveAgentIdOrRespondError(
      params.agentId,
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    respond(
      true,
      buildToolsCatalogResult({
        cfg: resolved.cfg,
        agentId: resolved.agentId,
        includePlugins: params.includePlugins,
      }),
      undefined,
    );
  },
};
