import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString as normalizeString } from "../shared/string-coerce.js";
import { normalizeTrimmedStringList } from "../shared/string-normalization.js";
import { isRecord } from "../utils.js";
import { enablePluginInConfig } from "./enable.js";
import type { PluginPackageInstall } from "./manifest.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginInstall,
  type OfficialExternalPluginCatalogEntry,
  type OfficialExternalPluginCatalogManifest,
  type OfficialExternalWebSearchProvider,
} from "./official-external-plugin-catalog.js";
import type { PluginWebSearchProviderEntry } from "./web-provider-types.js";

export type WebSearchInstallCatalogEntry = {
  pluginId: string;
  label: string;
  install: PluginPackageInstall;
  provider: PluginWebSearchProviderEntry;
  trustedSourceLinkedOfficialInstall?: boolean;
};

function normalizeOnboardingScopes(value: unknown): readonly "text-inference"[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const scopes = value.filter((entry): entry is "text-inference" => entry === "text-inference");
  return scopes.length > 0 ? scopes : undefined;
}

function readRecordValue(record: unknown, field: string): unknown {
  if (!isRecord(record)) {
    return undefined;
  }
  try {
    return record[field];
  } catch {
    return undefined;
  }
}

function readStringField(record: unknown, field: string): string | undefined {
  return normalizeString(readRecordValue(record, field));
}

function readNumberField(record: unknown, field: string): number | undefined {
  const value = readRecordValue(record, field);
  return typeof value === "number" ? value : undefined;
}

function readProviderArray(
  manifest: OfficialExternalPluginCatalogManifest,
): OfficialExternalWebSearchProvider[] {
  const providers = readRecordValue(manifest, "webSearchProviders");
  if (!Array.isArray(providers)) {
    return [];
  }
  const entries: OfficialExternalWebSearchProvider[] = [];
  for (let index = 0; index < providers.length; index += 1) {
    try {
      const provider = providers[index];
      if (isRecord(provider)) {
        entries.push(provider as OfficialExternalWebSearchProvider);
      }
    } catch {
      // Skip malformed catalog entries; healthy providers from the same catalog still load.
    }
  }
  return entries;
}

function readOfficialCatalogManifest(
  entry: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginCatalogManifest | undefined {
  try {
    return getOfficialExternalPluginCatalogManifest(entry);
  } catch {
    return undefined;
  }
}

function readOfficialCatalogInstall(entry: OfficialExternalPluginCatalogEntry) {
  try {
    return resolveOfficialExternalPluginInstall(entry);
  } catch {
    return null;
  }
}

function readOfficialCatalogLabel(
  entry: OfficialExternalPluginCatalogEntry,
  manifest: OfficialExternalPluginCatalogManifest,
  pluginId: string,
): string {
  return (
    readStringField(readRecordValue(manifest, "plugin"), "label") ??
    readStringField(readRecordValue(manifest, "channel"), "label") ??
    readStringField(readProviderArray(manifest)[0], "name") ??
    readStringField(entry, "name") ??
    pluginId
  );
}

function pathSegments(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function getConfigPath(config: OpenClawConfig | undefined, path: string): unknown {
  let current: unknown = config;
  for (const segment of pathSegments(path)) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setConfigPath(target: OpenClawConfig, path: string, value: unknown): void {
  const segments = pathSegments(path);
  let current: Record<string, unknown> = target as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = segments.at(-1);
  if (leaf) {
    current[leaf] = value;
  }
}

function buildProviderEntry(params: {
  pluginId: string;
  provider: unknown;
}): PluginWebSearchProviderEntry | null {
  const providerId = readStringField(params.provider, "id");
  const label = readStringField(params.provider, "label");
  const hint = readStringField(params.provider, "hint");
  const credentialPath =
    readStringField(params.provider, "credentialPath") ??
    `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
  const envVars = normalizeTrimmedStringList(readRecordValue(params.provider, "envVars"));
  const placeholder = readStringField(params.provider, "placeholder");
  const signupUrl = readStringField(params.provider, "signupUrl");
  if (!providerId || !label || !hint || envVars.length === 0 || !placeholder || !signupUrl) {
    return null;
  }
  const onboardingScopes = normalizeOnboardingScopes(
    readRecordValue(params.provider, "onboardingScopes"),
  );
  const credentialLabel = readStringField(params.provider, "credentialLabel");
  const docsUrl = readStringField(params.provider, "docsUrl");
  const autoDetectOrder = readNumberField(params.provider, "autoDetectOrder");
  return {
    id: providerId,
    pluginId: params.pluginId,
    label,
    hint,
    envVars,
    placeholder,
    signupUrl,
    credentialPath,
    ...(onboardingScopes ? { onboardingScopes } : {}),
    ...(readRecordValue(params.provider, "requiresCredential") === false
      ? { requiresCredential: false }
      : {}),
    ...(credentialLabel ? { credentialLabel } : {}),
    ...(docsUrl ? { docsUrl } : {}),
    ...(autoDetectOrder !== undefined ? { autoDetectOrder } : {}),
    getCredentialValue: (searchConfig?: Record<string, unknown>) => searchConfig?.apiKey,
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => {
      searchConfigTarget.apiKey = value;
    },
    getConfiguredCredentialValue: (config?: OpenClawConfig) =>
      getConfigPath(config, credentialPath),
    setConfiguredCredentialValue: (configTarget: OpenClawConfig, value: unknown) => {
      setConfigPath(configTarget, credentialPath, value);
    },
    applySelectionConfig: (config: OpenClawConfig) =>
      enablePluginInConfig(config, params.pluginId).config,
    createTool: () => null,
  };
}

export function resolveWebSearchInstallCatalogEntries(): WebSearchInstallCatalogEntry[] {
  const entries: WebSearchInstallCatalogEntry[] = [];
  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    const manifest = readOfficialCatalogManifest(entry);
    const pluginId = readStringField(readRecordValue(manifest, "plugin"), "id");
    const install = readOfficialCatalogInstall(entry);
    if (!manifest || !pluginId || !install) {
      continue;
    }
    for (const provider of readProviderArray(manifest)) {
      const providerEntry = buildProviderEntry({ pluginId, provider });
      if (!providerEntry) {
        continue;
      }
      entries.push({
        pluginId,
        label: readOfficialCatalogLabel(entry, manifest, pluginId),
        install,
        provider: providerEntry,
        trustedSourceLinkedOfficialInstall: true,
      });
    }
  }
  return entries.toSorted(
    (left, right) =>
      left.provider.label.localeCompare(right.provider.label) ||
      left.provider.id.localeCompare(right.provider.id),
  );
}

export function resolveWebSearchInstallCatalogEntry(params: {
  providerId?: string;
  pluginId?: string;
}): WebSearchInstallCatalogEntry | undefined {
  const providerId = normalizeString(params.providerId);
  const pluginId = normalizeString(params.pluginId);
  return resolveWebSearchInstallCatalogEntries().find(
    (entry) =>
      (!providerId || entry.provider.id === providerId) &&
      (!pluginId || entry.pluginId === pluginId),
  );
}
