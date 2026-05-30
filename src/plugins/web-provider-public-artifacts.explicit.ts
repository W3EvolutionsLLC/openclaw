import { isRecord } from "../shared/record-coerce.js";
import { sortUniqueStrings } from "../shared/string-normalization.js";
import {
  loadBundledPluginPublicArtifactModuleSync,
  resolveBundledPluginPublicArtifactPath,
} from "./public-surface-loader.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";

const WEB_SEARCH_ARTIFACT_CANDIDATES = [
  "web-search-contract-api.js",
  "web-search-provider.js",
  "web-search.js",
] as const;
const WEB_SEARCH_RUNTIME_ARTIFACT_CANDIDATES = ["web-search-provider.js", "web-search.js"] as const;
const WEB_FETCH_ARTIFACT_CANDIDATES = [
  "web-fetch-contract-api.js",
  "web-fetch-provider.js",
  "web-fetch.js",
] as const;
type WebProviderPlugin = WebSearchProviderPlugin | WebFetchProviderPlugin;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isWebProviderPlugin(
  value: unknown,
): value is WebSearchProviderPlugin | WebFetchProviderPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.hint === "string" &&
    isStringArray(value.envVars) &&
    typeof value.placeholder === "string" &&
    typeof value.signupUrl === "string" &&
    typeof value.credentialPath === "string" &&
    typeof value.getCredentialValue === "function" &&
    typeof value.setCredentialValue === "function" &&
    typeof value.createTool === "function"
  );
}

function isWebSearchProviderPlugin(value: unknown): value is WebSearchProviderPlugin {
  return isWebProviderPlugin(value);
}

function isWebFetchProviderPlugin(value: unknown): value is WebFetchProviderPlugin {
  return isWebProviderPlugin(value);
}

function readStringField(value: WebProviderPlugin, field: string): string | undefined {
  try {
    const fieldValue = (value as Record<string, unknown>)[field];
    return typeof fieldValue === "string" ? fieldValue : undefined;
  } catch {
    return undefined;
  }
}

function readStringArrayField(value: WebProviderPlugin, field: string): string[] | undefined {
  try {
    const fieldValue = (value as Record<string, unknown>)[field];
    return isStringArray(fieldValue) ? [...fieldValue] : undefined;
  } catch {
    return undefined;
  }
}

function readFunctionField(
  value: WebProviderPlugin,
  field: string,
): ((...args: unknown[]) => unknown) | undefined {
  try {
    const fieldValue = (value as Record<string, unknown>)[field];
    return typeof fieldValue === "function"
      ? (fieldValue as (...args: unknown[]) => unknown)
      : undefined;
  } catch {
    return undefined;
  }
}

function copyReadableWebProviderFields(provider: WebProviderPlugin): Record<string, unknown> {
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
      key === "hint" ||
      key === "envVars" ||
      key === "placeholder" ||
      key === "signupUrl" ||
      key === "credentialPath" ||
      key === "getCredentialValue" ||
      key === "setCredentialValue" ||
      key === "createTool" ||
      key === "pluginId"
    ) {
      continue;
    }
    try {
      fields[key] = (provider as Record<string, unknown>)[key];
    } catch {
      // Unreadable plugin-owned optional metadata is treated as absent.
    }
  }
  return fields;
}

function createWebProviderPublicArtifactEntry<TProvider extends WebProviderPlugin>(
  provider: TProvider,
  pluginId: string,
): (TProvider & { pluginId: string }) | undefined {
  const id = readStringField(provider, "id");
  const label = readStringField(provider, "label");
  const hint = readStringField(provider, "hint");
  const envVars = readStringArrayField(provider, "envVars");
  const placeholder = readStringField(provider, "placeholder");
  const signupUrl = readStringField(provider, "signupUrl");
  const credentialPath = readStringField(provider, "credentialPath");
  const getCredentialValue = readFunctionField(provider, "getCredentialValue");
  const setCredentialValue = readFunctionField(provider, "setCredentialValue");
  const createTool = readFunctionField(provider, "createTool");
  if (
    id === undefined ||
    label === undefined ||
    hint === undefined ||
    envVars === undefined ||
    placeholder === undefined ||
    signupUrl === undefined ||
    credentialPath === undefined ||
    getCredentialValue === undefined ||
    setCredentialValue === undefined ||
    createTool === undefined
  ) {
    return undefined;
  }
  const entry = {
    ...copyReadableWebProviderFields(provider),
    id,
    label,
    hint,
    envVars,
    placeholder,
    signupUrl,
    credentialPath,
    getCredentialValue,
    setCredentialValue,
    createTool,
    pluginId,
  };
  return entry as unknown as TProvider & { pluginId: string };
}

function collectProviderFactories<TProvider extends WebProviderPlugin>(params: {
  mod: Record<string, unknown>;
  pluginId: string;
  suffix: string;
  isProvider: (value: unknown) => value is TProvider;
}): Array<TProvider & { pluginId: string }> {
  const providers: Array<TProvider & { pluginId: string }> = [];
  for (const [name, exported] of Object.entries(params.mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith(params.suffix)
    ) {
      continue;
    }
    let candidate: unknown;
    try {
      candidate = exported();
    } catch {
      continue;
    }
    let provider: TProvider | undefined;
    try {
      provider = params.isProvider(candidate) ? candidate : undefined;
    } catch {
      provider = undefined;
    }
    if (provider) {
      const projected = createWebProviderPublicArtifactEntry(provider, params.pluginId);
      if (projected) {
        providers.push(projected);
      }
    }
  }
  return providers;
}

function tryLoadBundledPublicArtifactModule(params: {
  dirName: string;
  artifactCandidates: readonly string[];
}): Record<string, unknown> | null {
  for (const artifactBasename of params.artifactCandidates) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: params.dirName,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function normalizeExplicitBundledPluginIds(pluginIds: readonly string[]): string[] {
  return sortUniqueStrings(pluginIds);
}

function loadBundledProviderEntriesFromDir<TProvider extends WebProviderPlugin>(params: {
  dirName: string;
  pluginId: string;
  artifactCandidates: readonly string[];
  suffix: string;
  isProvider: (value: unknown) => value is TProvider;
}): Array<TProvider & { pluginId: string }> | null {
  const mod = tryLoadBundledPublicArtifactModule({
    dirName: params.dirName,
    artifactCandidates: params.artifactCandidates,
  });
  if (!mod) {
    return null;
  }
  const providers = collectProviderFactories({
    mod,
    pluginId: params.pluginId,
    suffix: params.suffix,
    isProvider: params.isProvider,
  });
  if (providers.length === 0) {
    return null;
  }
  return providers;
}

export function loadBundledWebSearchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebSearchProviderEntry[] | null {
  return loadBundledProviderEntriesFromDir<WebSearchProviderPlugin>({
    dirName: params.dirName,
    pluginId: params.pluginId,
    artifactCandidates: WEB_SEARCH_ARTIFACT_CANDIDATES,
    suffix: "WebSearchProvider",
    isProvider: isWebSearchProviderPlugin,
  });
}

function loadBundledRuntimeWebSearchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebSearchProviderEntry[] | null {
  return loadBundledProviderEntriesFromDir<WebSearchProviderPlugin>({
    dirName: params.dirName,
    pluginId: params.pluginId,
    artifactCandidates: WEB_SEARCH_RUNTIME_ARTIFACT_CANDIDATES,
    suffix: "WebSearchProvider",
    isProvider: isWebSearchProviderPlugin,
  });
}

export function loadBundledWebFetchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebFetchProviderEntry[] | null {
  return loadBundledProviderEntriesFromDir<WebFetchProviderPlugin>({
    dirName: params.dirName,
    pluginId: params.pluginId,
    artifactCandidates: WEB_FETCH_ARTIFACT_CANDIDATES,
    suffix: "WebFetchProvider",
    isProvider: isWebFetchProviderPlugin,
  });
}

export function resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebSearchProviderEntry[] | null {
  const providers: PluginWebSearchProviderEntry[] = [];
  for (const pluginId of normalizeExplicitBundledPluginIds(params.onlyPluginIds)) {
    const loadedProviders = loadBundledWebSearchProviderEntriesFromDir({
      dirName: pluginId,
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

export function resolveBundledExplicitRuntimeWebSearchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebSearchProviderEntry[] | null {
  const providers: PluginWebSearchProviderEntry[] = [];
  for (const pluginId of normalizeExplicitBundledPluginIds(params.onlyPluginIds)) {
    const loadedProviders = loadBundledRuntimeWebSearchProviderEntriesFromDir({
      dirName: pluginId,
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

export function resolveBundledExplicitWebFetchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebFetchProviderEntry[] | null {
  const providers: PluginWebFetchProviderEntry[] = [];
  for (const pluginId of normalizeExplicitBundledPluginIds(params.onlyPluginIds)) {
    const loadedProviders = loadBundledWebFetchProviderEntriesFromDir({
      dirName: pluginId,
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

function hasBundledPublicArtifactCandidate(params: {
  dirName: string;
  artifactCandidates: readonly string[];
}): boolean {
  return params.artifactCandidates.some((artifactBasename) =>
    Boolean(resolveBundledPluginPublicArtifactPath({ dirName: params.dirName, artifactBasename })),
  );
}

export function hasBundledWebSearchProviderPublicArtifact(pluginId: string): boolean {
  return hasBundledPublicArtifactCandidate({
    dirName: pluginId,
    artifactCandidates: WEB_SEARCH_ARTIFACT_CANDIDATES,
  });
}

export function hasBundledWebFetchProviderPublicArtifact(pluginId: string): boolean {
  return hasBundledPublicArtifactCandidate({
    dirName: pluginId,
    artifactCandidates: WEB_FETCH_ARTIFACT_CANDIDATES,
  });
}
