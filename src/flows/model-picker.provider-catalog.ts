import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
} from "../agents/models-config.providers.secrets.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { resolveProviderCatalogPluginIdsForFilter } from "../commands/models/list.provider-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import type { ProviderPlugin } from "../plugins/types.js";

const log = createSubsystemLogger("model-picker-provider-catalog");
const DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"] as const;

function readRecordValue(record: unknown, field: string): unknown {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  try {
    return (record as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function readStringField(record: unknown, field: string): string | undefined {
  const value = readRecordValue(record, field);
  return typeof value === "string" ? value : undefined;
}

function readNumberField(record: unknown, field: string): number | undefined {
  const value = readRecordValue(record, field);
  return typeof value === "number" ? value : undefined;
}

function readBooleanField(record: unknown, field: string): boolean | undefined {
  const value = readRecordValue(record, field);
  return typeof value === "boolean" ? value : undefined;
}

function readStringArrayField(record: unknown, field: string): string[] {
  const value = readRecordValue(record, field);
  try {
    if (!Array.isArray(value)) {
      return [];
    }
    const strings: string[] = [];
    for (let index = 0; index < value.length; index++) {
      let entry: unknown;
      try {
        entry = value[index];
      } catch {
        continue;
      }
      if (typeof entry === "string") {
        strings.push(entry);
      }
    }
    return strings;
  } catch {
    return [];
  }
}

function copyModelRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < length; index += 1) {
    let entry: unknown;
    try {
      entry = value[index];
    } catch {
      continue;
    }
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      rows.push(entry as Record<string, unknown>);
    }
  }
  return rows;
}

function readProviderCandidateIds(provider: unknown): string[] {
  return [
    readStringField(provider, "id"),
    ...readStringArrayField(provider, "aliases"),
    ...readStringArrayField(provider, "hookAliases"),
  ]
    .map((providerId) => (typeof providerId === "string" ? normalizeProviderId(providerId) : ""))
    .filter(Boolean);
}

function readProviderAuthId(provider: unknown, providerId?: string): string | undefined {
  const normalizedProviderId = normalizeProviderId(providerId?.trim() ?? "");
  if (normalizedProviderId) {
    return providerId?.trim();
  }
  return readStringField(provider, "id");
}

function hasRunnableProviderHook(provider: unknown, field: "catalog" | "discovery"): boolean {
  return typeof readRecordValue(readRecordValue(provider, field), "run") === "function";
}

function readProviderCatalogEntries(normalized: unknown): Array<[string, { models?: unknown }]> {
  if (typeof normalized !== "object" || normalized === null) {
    return [];
  }
  let keys: string[];
  try {
    keys = Object.keys(normalized);
  } catch {
    return [];
  }
  const record = normalized as Record<string, { models?: unknown }>;
  const entries: Array<[string, { models?: unknown }]> = [];
  for (const key of keys) {
    try {
      entries.push([key, record[key]]);
    } catch {
      continue;
    }
  }
  return entries;
}

function providerMatchesFilter(params: {
  provider: Pick<ProviderPlugin, "id" | "aliases" | "hookAliases">;
  providerFilter: string;
}): boolean {
  return readProviderCandidateIds(params.provider).some(
    (providerId) => providerId === params.providerFilter,
  );
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function providerAuthIds(provider: ProviderPlugin): string[] {
  return readProviderCandidateIds(provider);
}

function hasLiveProviderCatalog(provider: ProviderPlugin): boolean {
  return (
    hasRunnableProviderHook(provider, "catalog") || hasRunnableProviderHook(provider, "discovery")
  );
}

async function resolvePreferredProviderLiveCatalogProviders(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  onlyPluginIds: string[];
  providerFilter: string;
  workspaceDir?: string;
}): Promise<ProviderPlugin[]> {
  const providers = (
    await resolveRuntimePluginDiscoveryProviders({
      config: params.cfg,
      env: params.env,
      onlyPluginIds: params.onlyPluginIds,
      includeUntrustedWorkspacePlugins: false,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    })
  ).filter((provider) =>
    providerMatchesFilter({ provider, providerFilter: params.providerFilter }),
  );
  const liveProviders = providers.filter(hasLiveProviderCatalog);
  if (liveProviders.length > 0) {
    return liveProviders;
  }

  const { resolvePluginProviders } = await import("../plugins/providers.runtime.js");
  return resolvePluginProviders({
    config: params.cfg,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    includeUntrustedWorkspacePlugins: false,
    mode: "setup",
    activate: false,
    cache: false,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  }).filter(
    (provider) =>
      providerMatchesFilter({ provider, providerFilter: params.providerFilter }) &&
      hasLiveProviderCatalog(provider),
  );
}

function resolveProviderEnvApiKey(
  provider: ProviderPlugin,
  env: NodeJS.ProcessEnv,
):
  | {
      apiKey: string;
      discoveryApiKey?: string;
    }
  | undefined {
  for (const envVar of readStringArrayField(provider, "envVars")) {
    const normalized = envVar.trim();
    const value = env[normalized]?.trim();
    if (normalized && value) {
      return {
        apiKey: value,
        discoveryApiKey: value,
      };
    }
  }
  return undefined;
}

function modelFromProviderCatalog(params: {
  provider: string;
  providerConfig: unknown;
  model: unknown;
}): ModelCatalogEntry | undefined {
  const rawModelId = readStringField(params.model, "id");
  if (!rawModelId) {
    return undefined;
  }
  const id = normalizeConfiguredProviderCatalogModelId(params.provider, rawModelId);
  const modelName = readStringField(params.model, "name");
  const contextWindow =
    positiveNumber(readNumberField(params.model, "contextWindow")) ??
    positiveNumber(readNumberField(params.providerConfig, "contextWindow"));
  const contextTokens =
    positiveNumber(readNumberField(params.model, "contextTokens")) ??
    positiveNumber(readNumberField(params.providerConfig, "contextTokens"));
  const reasoning = readBooleanField(params.model, "reasoning");
  const input = readStringArrayField(params.model, "input");
  const compat = readRecordValue(params.model, "compat") as ModelCatalogEntry["compat"];
  return {
    id,
    name: modelName || id,
    provider: params.provider,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(input.length > 0 ? { input: input as ModelCatalogEntry["input"] } : {}),
    ...(compat ? { compat } : {}),
  };
}

export async function loadPreferredProviderPickerCatalog(params: {
  cfg: OpenClawConfig;
  preferredProvider: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelCatalogEntry[]> {
  const env = params.env ?? process.env;
  const agentDir = params.agentDir ?? resolveDefaultAgentDir(params.cfg, env);
  const providerFilter = normalizeProviderId(params.preferredProvider);
  if (!providerFilter) {
    return [];
  }

  const onlyPluginIds = await resolveProviderCatalogPluginIdsForFilter({
    cfg: params.cfg,
    env,
    providerFilter,
  });
  if (!onlyPluginIds || onlyPluginIds.length === 0) {
    return [];
  }

  const providers = await resolvePreferredProviderLiveCatalogProviders({
    cfg: params.cfg,
    env,
    onlyPluginIds,
    providerFilter,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (providers.length === 0) {
    return [];
  }

  let authStore: ReturnType<typeof ensureAuthProfileStoreWithoutExternalProfiles> | undefined;
  const getAuthStore = () =>
    (authStore ??= ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
      allowKeychainPrompt: false,
    }));
  const resolveProviderApiKey = createProviderApiKeyResolver(env, getAuthStore, params.cfg);
  const resolveProviderAuth = createProviderAuthResolver(env, getAuthStore, params.cfg);
  const resolveFastProviderApiKey = (provider: ProviderPlugin, providerId?: string) => {
    const resolvedProviderId = readProviderAuthId(provider, providerId);
    if (!resolvedProviderId) {
      return { apiKey: undefined, discoveryApiKey: undefined };
    }
    const normalizedProviderId = normalizeProviderId(resolvedProviderId);
    if (providerAuthIds(provider).includes(normalizedProviderId)) {
      const fromEnv = resolveProviderEnvApiKey(provider, env);
      if (fromEnv) {
        return fromEnv;
      }
    }
    return resolveProviderApiKey(resolvedProviderId);
  };
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const rows: ModelCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const order of DISCOVERY_ORDERS) {
    for (const provider of byOrder[order]) {
      let result: Awaited<ReturnType<typeof runProviderCatalog>>;
      const resolveCatalogProviderApiKey = (providerId?: string) =>
        resolveFastProviderApiKey(provider, providerId);
      const resolveCatalogProviderAuth = (
        providerId?: string,
        options?: { oauthMarker?: string },
      ) => resolveProviderAuth(readProviderAuthId(provider, providerId) ?? "", options);
      try {
        result = await runProviderCatalog({
          provider,
          config: params.cfg,
          env,
          resolveProviderApiKey: resolveCatalogProviderApiKey,
          resolveProviderAuth: resolveCatalogProviderAuth,
          agentDir,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
        });
      } catch (error) {
        log.warn(
          `provider catalog failed for ${readStringField(provider, "id") ?? "unknown"}: ${formatErrorMessage(error)}`,
        );
        continue;
      }

      let normalized: ReturnType<typeof normalizePluginDiscoveryResult>;
      try {
        normalized = normalizePluginDiscoveryResult({ provider, result });
      } catch {
        continue;
      }
      for (const [providerIdRaw, providerConfig] of readProviderCatalogEntries(normalized)) {
        const providerId = normalizeProviderId(providerIdRaw);
        const models = copyModelRows(readRecordValue(providerConfig, "models"));
        if (providerId !== providerFilter || models.length === 0) {
          continue;
        }
        for (const model of models) {
          const entry = modelFromProviderCatalog({
            provider: providerId,
            providerConfig,
            model,
          });
          if (!entry) {
            continue;
          }
          const key = `${entry.provider}/${entry.id}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          rows.push(entry);
        }
      }
    }
  }

  return rows;
}
