import type { OpenClawConfig } from "../config/types.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import {
  resolveCompatRegistryVersion,
  resolveInstalledPluginIndexPolicyHash,
} from "./installed-plugin-index-policy.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { resolveInstalledPluginIndexRegistry } from "./installed-plugin-index-registry.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_WARNING,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type InstalledPluginIndexRefreshReason,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";

export {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_WARNING,
} from "./installed-plugin-index-types.js";
export type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
  InstalledPluginIndexRefreshReason,
  InstalledPluginInstallRecordInfo,
  InstalledPluginPackageChannelInfo,
  InstalledPluginStartupInfo,
  LoadInstalledPluginIndexParams,
  RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";
export { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
export { diffInstalledPluginIndexInvalidationReasons } from "./installed-plugin-index-invalidation.js";
export { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readRecordValue(record: unknown, key: string): unknown {
  if (!isRecord(record)) {
    return undefined;
  }
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function readInstalledPluginIndexRecords(
  pluginIndex: InstalledPluginIndex,
): InstalledPluginIndexRecord[] {
  const plugins = readRecordValue(pluginIndex, "plugins");
  if (!Array.isArray(plugins)) {
    return [];
  }
  let length: number;
  try {
    length = plugins.length;
  } catch {
    return [];
  }

  const records: InstalledPluginIndexRecord[] = [];
  for (let slotIndex = 0; slotIndex < length; slotIndex += 1) {
    let record: unknown;
    try {
      record = plugins[slotIndex];
    } catch {
      continue;
    }
    if (typeof readRecordValue(record, "pluginId") === "string") {
      records.push(record as InstalledPluginIndexRecord);
    }
  }
  return records;
}

function readInstalledPluginRecordId(record: InstalledPluginIndexRecord): string | undefined {
  const pluginId = readRecordValue(record, "pluginId");
  return typeof pluginId === "string" && pluginId ? pluginId : undefined;
}

function readInstalledPluginRecordEnabled(record: InstalledPluginIndexRecord): boolean {
  return readRecordValue(record, "enabled") === true;
}

function readInstalledPluginRecordOrigin(
  record: InstalledPluginIndexRecord,
): InstalledPluginIndexRecord["origin"] | undefined {
  const origin = readRecordValue(record, "origin");
  return origin === "bundled" ||
    origin === "global" ||
    origin === "workspace" ||
    origin === "config"
    ? origin
    : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (let index = 0; index < length; index += 1) {
    let entry: unknown;
    try {
      entry = value[index];
    } catch {
      continue;
    }
    if (typeof entry === "string") {
      entries.push(entry);
    }
  }
  return entries;
}

function isInstalledPluginRecordEnabledByDefault(record: InstalledPluginIndexRecord): boolean {
  return isPluginEnabledByDefaultForPlatform({
    enabledByDefault: readRecordValue(record, "enabledByDefault") === true,
    enabledByDefaultOnPlatforms: readStringArray(
      readRecordValue(record, "enabledByDefaultOnPlatforms"),
    ),
  });
}

function buildInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams & { refreshReason?: InstalledPluginIndexRefreshReason },
): { index: InstalledPluginIndex; discovery: PluginDiscoveryResult | undefined } {
  const env = params.env ?? process.env;
  const { candidates, registry, discovery } = resolveInstalledPluginIndexRegistry(params);
  const registryDiagnostics = registry.diagnostics ?? [];
  const diagnostics = [...registryDiagnostics];
  const generatedAtMs = (params.now?.() ?? new Date()).getTime();
  const installRecords = normalizeInstallRecordMap(
    params.installRecords ??
      loadInstalledPluginIndexInstallRecordsSync({
        env,
        ...(params.stateDir ? { stateDir: params.stateDir } : {}),
        ...(params.pluginIndexFilePath ? { filePath: params.pluginIndexFilePath } : {}),
      }),
  );
  const plugins = buildInstalledPluginIndexRecords({
    candidates,
    registry,
    config: params.config,
    diagnostics,
    installRecords,
  });

  return {
    index: {
      version: INSTALLED_PLUGIN_INDEX_VERSION,
      warning: INSTALLED_PLUGIN_INDEX_WARNING,
      hostContractVersion: resolveCompatibilityHostVersion(env),
      compatRegistryVersion: resolveCompatRegistryVersion(),
      migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
      generatedAtMs,
      ...(params.refreshReason ? { refreshReason: params.refreshReason } : {}),
      installRecords,
      plugins,
      diagnostics,
    },
    discovery,
  };
}

export function loadInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams = {},
): InstalledPluginIndex {
  return buildInstalledPluginIndex(params).index;
}

export function loadInstalledPluginIndexWithDiscovery(
  params: LoadInstalledPluginIndexParams = {},
): { index: InstalledPluginIndex; discovery: PluginDiscoveryResult | undefined } {
  return buildInstalledPluginIndex(params);
}

export function refreshInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  return buildInstalledPluginIndex({ ...params, refreshReason: params.reason }).index;
}

export function listInstalledPluginRecords(
  index: InstalledPluginIndex,
): readonly InstalledPluginIndexRecord[] {
  return readInstalledPluginIndexRecords(index);
}

export function listEnabledInstalledPluginRecords(
  index: InstalledPluginIndex,
  config?: OpenClawConfig,
): readonly InstalledPluginIndexRecord[] {
  if (!config) {
    return readInstalledPluginIndexRecords(index).filter(readInstalledPluginRecordEnabled);
  }
  return readInstalledPluginIndexRecords(index).filter((plugin) => {
    const pluginId = readInstalledPluginRecordId(plugin);
    return Boolean(pluginId && isInstalledPluginEnabled(index, pluginId, config));
  });
}

export function getInstalledPluginRecord(
  index: InstalledPluginIndex,
  pluginId: string,
): InstalledPluginIndexRecord | undefined {
  return readInstalledPluginIndexRecords(index).find(
    (plugin) => readInstalledPluginRecordId(plugin) === pluginId,
  );
}

export function isInstalledPluginEnabled(
  index: InstalledPluginIndex,
  pluginId: string,
  config?: OpenClawConfig,
): boolean {
  const record = getInstalledPluginRecord(index, pluginId);
  if (!record) {
    return false;
  }
  const recordPluginId = readInstalledPluginRecordId(record);
  if (!recordPluginId) {
    return false;
  }
  const recordEnabled = readInstalledPluginRecordEnabled(record);
  if (!config) {
    return recordEnabled;
  }
  const origin = readInstalledPluginRecordOrigin(record);
  if (!origin) {
    return false;
  }
  const normalizedConfig = normalizePluginsConfig(config?.plugins);
  const state = resolveEffectivePluginActivationState({
    id: recordPluginId,
    origin,
    config: normalizedConfig,
    rootConfig: config,
    enabledByDefault: isInstalledPluginRecordEnabledByDefault(record),
  });
  return state.enabled && (recordEnabled || state.explicitlyEnabled);
}
