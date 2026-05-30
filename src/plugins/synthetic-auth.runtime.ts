import { normalizeProviderId } from "../agents/provider-id.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry.js";
import type { LoadPluginRegistryParams, PluginRegistrySnapshot } from "./plugin-registry.js";
import { getPluginRegistryState } from "./runtime-state.js";

function uniqueProviderRefs(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    const normalized = normalizeProviderId(trimmed);
    if (!trimmed || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(trimmed);
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecordValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function copyArrayEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length = 0;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      entries.push(value[index]);
    } catch {
      // Skip unreadable runtime registry entries; later healthy entries can still supply refs.
    }
  }
  return entries;
}

function copyStringArrayEntries(value: unknown): string[] {
  return copyArrayEntries(value).filter((entry): entry is string => typeof entry === "string");
}

function listRuntimePluginSyntheticAuthRefs(plugin: unknown): string[] {
  return copyStringArrayEntries(readRecordValue(plugin, "syntheticAuthRefs"));
}

function listRuntimePluginExternalAuthProviderRefs(plugin: unknown): string[] {
  return copyStringArrayEntries(
    readRecordValue(readRecordValue(plugin, "contracts"), "externalAuthProviders"),
  );
}

function readHookProviderId(
  entry: unknown,
  ownerKey: "provider" | "backend",
  hookNames: string[],
): string[] {
  const owner = readRecordValue(entry, ownerKey);
  const hasHook = hookNames.some(
    (hookName) => typeof readRecordValue(owner, hookName) === "function",
  );
  if (!hasHook) {
    return [];
  }
  const id = readRecordValue(owner, "id");
  return typeof id === "string" ? [id] : [];
}

function resolveManifestSyntheticAuthProviderRefState(
  params: SyntheticAuthProviderRefParams = {},
): { refs: string[]; complete: boolean } {
  if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) {
    return { refs: [], complete: false };
  }
  const result = loadPluginRegistrySnapshotWithMetadata(params);
  if (result.source !== "persisted" && result.source !== "provided") {
    return { refs: [], complete: false };
  }
  return {
    refs: uniqueProviderRefs(
      result.snapshot.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []),
    ),
    complete: true,
  };
}

type SyntheticAuthProviderRefParams = LoadPluginRegistryParams & {
  index?: PluginRegistrySnapshot;
  registryDiagnostics?: readonly unknown[];
};

function resolveManifestExternalAuthProviderRefs(
  params: SyntheticAuthProviderRefParams = {},
): string[] {
  if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) {
    return [];
  }
  const result = loadPluginRegistrySnapshotWithMetadata(params);
  if (result.source !== "persisted" && result.source !== "provided") {
    return [];
  }
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index: result.snapshot,
  });
  return uniqueProviderRefs(
    manifestRegistry.plugins.flatMap((plugin) => plugin.contracts?.externalAuthProviders ?? []),
  );
}

export function resolveRuntimeSyntheticAuthProviderRefs(
  params: SyntheticAuthProviderRefParams = {},
): string[] {
  return resolveRuntimeSyntheticAuthProviderRefState(params).refs;
}

export function resolveRuntimeSyntheticAuthProviderRefState(
  params: SyntheticAuthProviderRefParams = {},
): { refs: string[]; complete: boolean } {
  const registry = getPluginRegistryState()?.activeRegistry;
  if (registry) {
    return {
      refs: uniqueProviderRefs([
        ...copyArrayEntries(registry.plugins).flatMap(listRuntimePluginSyntheticAuthRefs),
        ...copyArrayEntries(registry.providers).flatMap((entry) =>
          readHookProviderId(entry, "provider", ["resolveSyntheticAuth"]),
        ),
        ...copyArrayEntries(registry.cliBackends).flatMap((entry) =>
          readHookProviderId(entry, "backend", ["resolveSyntheticAuth"]),
        ),
      ]),
      complete: true,
    };
  }
  return resolveManifestSyntheticAuthProviderRefState(params);
}

export function resolveRuntimeExternalAuthProviderRefs(
  params: SyntheticAuthProviderRefParams = {},
): string[] {
  const registry = getPluginRegistryState()?.activeRegistry;
  if (registry) {
    return uniqueProviderRefs([
      ...copyArrayEntries(registry.plugins).flatMap(listRuntimePluginExternalAuthProviderRefs),
      ...copyArrayEntries(registry.providers).flatMap((entry) =>
        readHookProviderId(entry, "provider", [
          "resolveExternalAuthProfiles",
          "resolveExternalOAuthProfiles",
        ]),
      ),
      ...copyArrayEntries(registry.cliBackends).flatMap((entry) =>
        readHookProviderId(entry, "backend", [
          "resolveExternalAuthProfiles",
          "resolveExternalOAuthProfiles",
        ]),
      ),
    ]);
  }
  return resolveManifestExternalAuthProviderRefs(params);
}
