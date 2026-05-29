import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveBundledPluginRepoEntryPath } from "./bundled-plugin-metadata.js";
import { createCapturedPluginRegistration } from "./captured-registration.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
  type PluginModuleLoaderCache,
} from "./plugin-module-loader-cache.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import {
  buildPluginLoaderAliasMap,
  shouldPreferNativeModuleLoad,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";
import {
  findUndeclaredPluginToolNames,
  normalizePluginToolContractNames,
} from "./tool-contracts.js";
import type { AnyAgentTool, OpenClawPluginDefinition, OpenClawPluginModule } from "./types.js";

const log = createSubsystemLogger("plugins");

const CAPABILITY_VITEST_SHIM_ALIASES = [
  {
    subpath: "config-runtime",
    target: new URL("./capability-runtime-vitest-shims/config-runtime.ts", import.meta.url),
  },
  {
    subpath: "media-runtime",
    target: new URL("./capability-runtime-vitest-shims/media-runtime.ts", import.meta.url),
  },
  {
    subpath: "provider-onboard",
    target: new URL("../plugin-sdk/provider-onboard.ts", import.meta.url),
  },
  {
    subpath: "speech-core",
    target: new URL("./capability-runtime-vitest-shims/speech-core.ts", import.meta.url),
  },
] as const;

export function buildVitestCapabilityShimAliasMap(): Record<string, string> {
  return Object.fromEntries(
    CAPABILITY_VITEST_SHIM_ALIASES.flatMap(({ subpath, target }) => {
      const targetPath = fileURLToPath(target);
      return [
        [`openclaw/plugin-sdk/${subpath}`, targetPath],
        [`@openclaw/plugin-sdk/${subpath}`, targetPath],
      ];
    }),
  );
}

function applyVitestCapabilityAliasOverrides(params: {
  aliasMap: Record<string, string>;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  env?: PluginLoadOptions["env"];
}): Record<string, string> {
  if (!params.env?.VITEST || params.pluginSdkResolution !== "dist") {
    return params.aliasMap;
  }

  const {
    "openclaw/plugin-sdk": _ignoredLegacyRootAlias,
    "@openclaw/plugin-sdk": _ignoredScopedRootAlias,
    ...scopedAliasMap
  } = params.aliasMap;
  return {
    ...scopedAliasMap,
    // Capability contract loads only need a narrow SDK slice. Keep those
    // helpers on a tiny source graph so Vitest does not pull the dist chunk
    // bundle that also drags Matrix/WhatsApp code into these tests.
    ...buildVitestCapabilityShimAliasMap(),
  };
}

function shouldApplyVitestCapabilityAliasOverrides(params: {
  pluginSdkResolution?: PluginSdkResolutionPreference;
  env?: PluginLoadOptions["env"];
}): boolean {
  return Boolean(params.env?.VITEST && params.pluginSdkResolution === "dist");
}

export function buildBundledCapabilityRuntimeConfig(
  pluginIds: readonly string[],
  env?: PluginLoadOptions["env"],
): PluginLoadOptions["config"] {
  const enablementCompat = withBundledPluginEnablementCompat({
    config: undefined,
    pluginIds,
  });
  return withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds,
    env,
  });
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const definition = resolved as OpenClawPluginDefinition;
    return {
      definition,
      register: definition.register ?? definition.activate,
    };
  }
  return {};
}

function createCapabilityPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  contracts?: PluginRecord["contracts"];
  source: string;
  rootDir?: string;
  workspaceDir?: string;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    version: params.version,
    description: params.description,
    contracts: params.contracts,
    source: params.source,
    rootDir: params.rootDir,
    origin: "bundled",
    workspaceDir: params.workspaceDir,
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    embeddingProviderIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    transcriptSourceProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: true,
  };
}

function recordCapabilityLoadError(
  registry: PluginRegistry,
  record: PluginRecord,
  message: string,
): void {
  record.status = "error";
  record.error = message;
  registry.plugins.push(record);
  registry.diagnostics.push({
    level: "error",
    pluginId: record.id,
    source: record.source,
    message: `failed to load plugin: ${message}`,
  });
  log.error(`[plugins] ${record.id} failed to load from ${record.source}: ${message}`);
}

function readCapturedPluginToolName(tool: AnyAgentTool): string {
  try {
    const name = tool.name;
    return typeof name === "string" ? name.trim() : "";
  } catch {
    return "";
  }
}

function pushUnreadableCapturedToolDiagnostic(registry: PluginRegistry, record: PluginRecord) {
  registry.diagnostics.push({
    level: "error",
    pluginId: record.id,
    source: record.source,
    message: "plugin tool registration missing readable tool name",
  });
}

function readCapturedRegistrationId(entry: object): string {
  try {
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" ? id.trim() : "";
  } catch {
    return "";
  }
}

function pushUnreadableCapturedRegistrationIdDiagnostic(
  registry: PluginRegistry,
  record: PluginRecord,
  kind: string,
) {
  registry.diagnostics.push({
    level: "error",
    pluginId: record.id,
    source: record.source,
    message: `plugin ${kind} registration missing readable id`,
  });
}

function filterCapturedRegistrationsWithReadableIds<T extends object>(
  registry: PluginRegistry,
  record: PluginRecord,
  kind: string,
  entries: readonly T[],
): Array<{ id: string; registration: T }> {
  return entries.flatMap((registration) => {
    const id = readCapturedRegistrationId(registration);
    if (!id) {
      pushUnreadableCapturedRegistrationIdDiagnostic(registry, record, kind);
      return [];
    }
    return [{ id, registration }];
  });
}

export function loadBundledCapabilityRuntimeRegistry(params: {
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
  pluginSdkResolution?: PluginSdkResolutionPreference;
  discovery?: PluginDiscoveryResult;
}) {
  const env = params.env ?? process.env;
  const pluginIds = new Set(params.pluginIds);
  const registry = createEmptyPluginRegistry();
  const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();

  const getModuleLoader = (modulePath: string) => {
    const tryNative =
      shouldPreferNativeModuleLoad(modulePath) &&
      !(env?.VITEST && params.pluginSdkResolution === "dist");
    const aliasMap = shouldApplyVitestCapabilityAliasOverrides({
      pluginSdkResolution: params.pluginSdkResolution,
      env,
    })
      ? applyVitestCapabilityAliasOverrides({
          aliasMap: buildPluginLoaderAliasMap(
            modulePath,
            process.argv[1],
            import.meta.url,
            params.pluginSdkResolution,
          ),
          pluginSdkResolution: params.pluginSdkResolution,
          env,
        })
      : undefined;
    return getCachedPluginModuleLoader({
      cache: moduleLoaders,
      modulePath,
      importerUrl: import.meta.url,
      loaderFilename: import.meta.url,
      ...(aliasMap ? { aliasMap } : {}),
      pluginSdkResolution: params.pluginSdkResolution,
      tryNative,
    });
  };

  const discovery = params.discovery ?? discoverOpenClawPlugins({ env });
  const manifestRegistry = loadPluginManifestRegistry({
    config: buildBundledCapabilityRuntimeConfig(params.pluginIds, env),
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  registry.diagnostics.push(...manifestRegistry.diagnostics);

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const seenPluginIds = new Set<string>();
  const repoRoot = process.cwd();

  for (const candidate of discovery.candidates) {
    const manifest = manifestByRoot.get(candidate.rootDir);
    if (!manifest || manifest.origin !== "bundled" || !pluginIds.has(manifest.id)) {
      continue;
    }
    if (seenPluginIds.has(manifest.id)) {
      continue;
    }
    seenPluginIds.add(manifest.id);

    const record = createCapabilityPluginRecord({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      contracts: manifest.contracts,
      source:
        env?.VITEST && params.pluginSdkResolution === "dist"
          ? (resolveBundledPluginRepoEntryPath({
              rootDir: repoRoot,
              pluginId: manifest.id,
              preferBuilt: true,
            }) ?? candidate.source)
          : candidate.source,
      rootDir: candidate.rootDir,
      workspaceDir: candidate.workspaceDir,
    });

    const opened = openRootFileSync({
      absolutePath: record.source,
      rootPath: record.source === candidate.source ? candidate.rootDir : repoRoot,
      boundaryLabel: record.source === candidate.source ? "plugin root" : "repo root",
      rejectHardlinks: false,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      recordCapabilityLoadError(
        registry,
        record,
        "plugin entry path escapes plugin root or fails alias checks",
      );
      continue;
    }

    const safeSource = opened.path;
    fs.closeSync(opened.fd);

    let mod: OpenClawPluginModule | null = null;
    try {
      mod = getModuleLoader(safeSource)(safeSource) as OpenClawPluginModule;
    } catch (error) {
      recordCapabilityLoadError(registry, record, String(error));
      continue;
    }

    const resolved = resolvePluginModuleExport(mod);
    const register = resolved.register;
    if (typeof register !== "function") {
      record.status = "disabled";
      record.error = "plugin export missing register(api)";
      registry.plugins.push(record);
      continue;
    }

    try {
      const captured = createCapturedPluginRegistration();
      register(captured.api);
      const capturedCliBackends = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "cli backend",
        captured.cliBackends,
      );
      const capturedProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "provider",
        captured.providers,
      );
      const capturedEmbeddingProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "embedding provider",
        captured.embeddingProviders,
      );
      const capturedSpeechProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "speech provider",
        captured.speechProviders,
      );
      const capturedRealtimeTranscriptionProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "realtime transcription provider",
        captured.realtimeTranscriptionProviders,
      );
      const capturedRealtimeVoiceProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "realtime voice provider",
        captured.realtimeVoiceProviders,
      );
      const capturedMediaUnderstandingProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "media understanding provider",
        captured.mediaUnderstandingProviders,
      );
      const capturedTranscriptSourceProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "transcript source provider",
        captured.transcriptSourceProviders,
      );
      const capturedImageGenerationProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "image generation provider",
        captured.imageGenerationProviders,
      );
      const capturedVideoGenerationProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "video generation provider",
        captured.videoGenerationProviders,
      );
      const capturedMusicGenerationProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "music generation provider",
        captured.musicGenerationProviders,
      );
      const capturedWebFetchProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "web fetch provider",
        captured.webFetchProviders,
      );
      const capturedWebSearchProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "web search provider",
        captured.webSearchProviders,
      );
      const capturedMigrationProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "migration provider",
        captured.migrationProviders,
      );
      const capturedMemoryEmbeddingProviders = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "memory embedding provider",
        captured.memoryEmbeddingProviders,
      );
      const capturedAgentHarnesses = filterCapturedRegistrationsWithReadableIds(
        registry,
        record,
        "agent harness",
        captured.agentHarnesses,
      );
      record.cliBackendIds.push(...capturedCliBackends.map((entry) => entry.id));
      record.providerIds.push(...capturedProviders.map((entry) => entry.id));
      record.embeddingProviderIds.push(...capturedEmbeddingProviders.map((entry) => entry.id));
      record.speechProviderIds.push(...capturedSpeechProviders.map((entry) => entry.id));
      record.realtimeTranscriptionProviderIds.push(
        ...capturedRealtimeTranscriptionProviders.map((entry) => entry.id),
      );
      record.realtimeVoiceProviderIds.push(
        ...capturedRealtimeVoiceProviders.map((entry) => entry.id),
      );
      record.mediaUnderstandingProviderIds.push(
        ...capturedMediaUnderstandingProviders.map((entry) => entry.id),
      );
      record.transcriptSourceProviderIds.push(
        ...capturedTranscriptSourceProviders.map((entry) => entry.id),
      );
      record.imageGenerationProviderIds.push(
        ...capturedImageGenerationProviders.map((entry) => entry.id),
      );
      record.videoGenerationProviderIds.push(
        ...capturedVideoGenerationProviders.map((entry) => entry.id),
      );
      record.musicGenerationProviderIds.push(
        ...capturedMusicGenerationProviders.map((entry) => entry.id),
      );
      record.webFetchProviderIds.push(...capturedWebFetchProviders.map((entry) => entry.id));
      record.webSearchProviderIds.push(...capturedWebSearchProviders.map((entry) => entry.id));
      record.migrationProviderIds.push(...capturedMigrationProviders.map((entry) => entry.id));
      record.memoryEmbeddingProviderIds.push(
        ...capturedMemoryEmbeddingProviders.map((entry) => entry.id),
      );
      record.agentHarnessIds.push(...capturedAgentHarnesses.map((entry) => entry.id));
      const capturedTools = captured.tools.flatMap((tool) => {
        const name = readCapturedPluginToolName(tool);
        if (!name) {
          pushUnreadableCapturedToolDiagnostic(registry, record);
          return [];
        }
        return [{ name, tool }];
      });
      record.toolNames.push(...capturedTools.map((entry) => entry.name));

      registry.cliBackends?.push(
        ...capturedCliBackends.map(({ registration: backend }) => ({
          pluginId: record.id,
          pluginName: record.name,
          backend,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.textTransforms.push(
        ...captured.textTransforms.map((transforms) => ({
          pluginId: record.id,
          pluginName: record.name,
          transforms,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.providers.push(
        ...capturedProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.embeddingProviders.push(
        ...capturedEmbeddingProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.speechProviders.push(
        ...capturedSpeechProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.realtimeTranscriptionProviders.push(
        ...capturedRealtimeTranscriptionProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.realtimeVoiceProviders.push(
        ...capturedRealtimeVoiceProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.mediaUnderstandingProviders.push(
        ...capturedMediaUnderstandingProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.transcriptSourceProviders.push(
        ...capturedTranscriptSourceProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.imageGenerationProviders.push(
        ...capturedImageGenerationProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.videoGenerationProviders.push(
        ...capturedVideoGenerationProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.musicGenerationProviders.push(
        ...capturedMusicGenerationProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.webFetchProviders.push(
        ...capturedWebFetchProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.webSearchProviders.push(
        ...capturedWebSearchProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.migrationProviders.push(
        ...capturedMigrationProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.memoryEmbeddingProviders.push(
        ...capturedMemoryEmbeddingProviders.map(({ registration: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.agentHarnesses.push(
        ...capturedAgentHarnesses.map(({ registration: harness }) => ({
          pluginId: record.id,
          pluginName: record.name,
          harness,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      const declaredToolNames = normalizePluginToolContractNames(record.contracts);
      for (const { name, tool } of capturedTools) {
        const undeclared = findUndeclaredPluginToolNames({
          declaredNames: declaredToolNames,
          toolNames: [name],
        });
        if (undeclared.length > 0) {
          registry.diagnostics.push({
            level: "error",
            pluginId: record.id,
            source: record.source,
            message: `plugin must declare contracts.tools for: ${undeclared.join(", ")}`,
          });
          continue;
        }
        registry.tools.push({
          pluginId: record.id,
          pluginName: record.name,
          factory: () => tool,
          names: [name],
          declaredNames: declaredToolNames,
          optional: false,
          source: record.source,
          rootDir: record.rootDir,
        });
      }
      registry.plugins.push(record);
    } catch (error) {
      recordCapabilityLoadError(registry, record, String(error));
    }
  }

  return registry;
}
