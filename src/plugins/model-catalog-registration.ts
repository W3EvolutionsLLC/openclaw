import {
  synthesizeMediaGenerationCatalogEntries,
  type MediaGenerationCatalogKind,
  type MediaGenerationCatalogProvider,
} from "../../packages/media-generation-core/src/catalog.js";
import {
  synthesizeVoiceModelCatalogEntries,
  type VoiceModelCapabilities,
  type VoiceModelProvider,
} from "../../packages/speech-core/voice-models.js";
import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogKind,
  UnifiedModelCatalogSource,
} from "../model-catalog/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { uniqueValues } from "../shared/string-normalization.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { projectProviderCatalogResultToUnifiedTextRows } from "./provider-catalog-unified-text.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import type {
  ProviderPlugin,
  UnifiedModelCatalogProviderContext,
  UnifiedModelCatalogProviderPlugin,
} from "./types.js";

type UnifiedModelCatalogHook = NonNullable<UnifiedModelCatalogProviderPlugin["staticCatalog"]>;
type ReadPluginFieldResult = { ok: true; value: unknown } | { ok: false };

const allowedModelCatalogKinds = new Set<UnifiedModelCatalogKind>([
  "text",
  "voice",
  "image_generation",
  "video_generation",
  "music_generation",
]);

function isUnifiedModelCatalogKind(value: string): value is UnifiedModelCatalogKind {
  return allowedModelCatalogKinds.has(value as UnifiedModelCatalogKind);
}

function readPluginField(value: unknown, key: string): ReadPluginFieldResult {
  try {
    return { ok: true, value: (value as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

function normalizeCatalogKinds(
  value: unknown,
):
  | { ok: true; kinds: UnifiedModelCatalogKind[] }
  | { ok: false; reason: "invalid" | "unreadable" } {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!isArray) {
    return { ok: false, reason: "invalid" };
  }

  let entries: unknown[];
  try {
    entries = Array.from(value as readonly unknown[]);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const kinds: UnifiedModelCatalogKind[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !isUnifiedModelCatalogKind(entry)) {
      return { ok: false, reason: "invalid" };
    }
    kinds.push(entry);
  }
  return { ok: true, kinds: uniqueValues(kinds) };
}

function normalizeCatalogHook(
  provider: UnifiedModelCatalogProviderPlugin,
  value: unknown,
): UnifiedModelCatalogHook | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "function") {
    return null;
  }
  return (ctx) => value.call(provider, ctx);
}

function mergeCatalogHookResults(
  source: UnifiedModelCatalogSource,
  left: readonly UnifiedModelCatalogEntry[] | null | undefined,
  right: readonly UnifiedModelCatalogEntry[] | null | undefined,
): readonly UnifiedModelCatalogEntry[] | null {
  const rows = [...(left ?? []), ...(right ?? [])];
  if (rows.length === 0) {
    return null;
  }
  const mergedRows: UnifiedModelCatalogEntry[] = [];
  for (const row of rows) {
    mergedRows.push({ ...row, source });
  }
  return mergedRows;
}

function mergeModelCatalogHooks(
  source: UnifiedModelCatalogSource,
  left: UnifiedModelCatalogHook | undefined,
  right: UnifiedModelCatalogHook | undefined,
): UnifiedModelCatalogHook | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return async (ctx) => {
    const [leftRows, rightRows] = await Promise.all([left(ctx), right(ctx)]);
    return mergeCatalogHookResults(source, leftRows, rightRows);
  };
}

export function createModelCatalogRegistrationHandlers(params: {
  registry: PluginRegistry;
  pushDiagnostic: (diagnostic: PluginDiagnostic) => void;
}) {
  const normalizeModelCatalogProvider = (
    record: PluginRecord,
    provider: UnifiedModelCatalogProviderPlugin,
  ): UnifiedModelCatalogProviderPlugin | null => {
    const providerValue = readPluginField(provider, "provider");
    if (!providerValue.ok) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "model catalog provider registration has unreadable field: provider",
      });
      return null;
    }
    const providerId = normalizeOptionalString(providerValue.value) ?? "";
    if (!providerId) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "model catalog provider registration missing provider",
      });
      return null;
    }

    const kindsValue = readPluginField(provider, "kinds");
    if (!kindsValue.ok) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `model catalog provider "${providerId}" registration has unreadable field: kinds`,
      });
      return null;
    }
    const normalizedKinds = normalizeCatalogKinds(kindsValue.value);
    if (!normalizedKinds.ok) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          normalizedKinds.reason === "unreadable"
            ? `model catalog provider "${providerId}" registration has unreadable field: kinds`
            : `model catalog provider "${providerId}" registration missing kinds`,
      });
      return null;
    }
    if (normalizedKinds.kinds.length === 0) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `model catalog provider "${providerId}" registration missing kinds`,
      });
      return null;
    }

    const staticCatalogValue = readPluginField(provider, "staticCatalog");
    const liveCatalogValue = readPluginField(provider, "liveCatalog");
    if (!staticCatalogValue.ok) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `model catalog provider "${providerId}" registration has unreadable field: staticCatalog`,
      });
      return null;
    }
    if (!liveCatalogValue.ok) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `model catalog provider "${providerId}" registration has unreadable field: liveCatalog`,
      });
      return null;
    }

    const staticCatalog = normalizeCatalogHook(provider, staticCatalogValue.value);
    const liveCatalog = normalizeCatalogHook(provider, liveCatalogValue.value);
    const invalidHook =
      staticCatalog === null ? "staticCatalog" : liveCatalog === null ? "liveCatalog" : undefined;
    if (invalidHook) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `model catalog provider "${providerId}" registration has invalid field: ${invalidHook}`,
      });
      return null;
    }

    return {
      provider: providerId,
      kinds: normalizedKinds.kinds,
      ...(staticCatalog ? { staticCatalog } : {}),
      ...(liveCatalog ? { liveCatalog } : {}),
    };
  };

  const registerModelCatalogProvider = (
    record: PluginRecord,
    provider: UnifiedModelCatalogProviderPlugin,
  ) => {
    const normalizedProvider = normalizeModelCatalogProvider(record, provider);
    if (!normalizedProvider) {
      return;
    }
    const providerId = normalizedProvider.provider;
    const existing = params.registry.modelCatalogProviders.find(
      (entry) => entry.provider.provider === providerId && entry.pluginId !== record.id,
    );
    if (existing) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `model catalog provider already registered: ${providerId} (${existing.pluginId})`,
      });
      return;
    }
    const samePluginOverlapping = params.registry.modelCatalogProviders.find(
      (entry) =>
        entry.provider.provider === providerId &&
        entry.pluginId === record.id &&
        entry.provider.kinds.some((kind) => normalizedProvider.kinds.includes(kind)),
    );
    if (samePluginOverlapping) {
      samePluginOverlapping.provider = {
        provider: providerId,
        kinds: uniqueValues([...samePluginOverlapping.provider.kinds, ...normalizedProvider.kinds]),
        staticCatalog: mergeModelCatalogHooks(
          "static",
          samePluginOverlapping.provider.staticCatalog,
          normalizedProvider.staticCatalog,
        ),
        liveCatalog: mergeModelCatalogHooks(
          "live",
          samePluginOverlapping.provider.liveCatalog,
          normalizedProvider.liveCatalog,
        ),
      };
      return;
    }
    params.registry.modelCatalogProviders.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: normalizedProvider,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSynthesizedTextModelCatalogProvider = (registration: {
    record: PluginRecord;
    provider: ProviderPlugin;
  }) => {
    if (!registration.provider.catalog && !registration.provider.staticCatalog) {
      return;
    }
    registerModelCatalogProvider(registration.record, {
      provider: registration.provider.id,
      kinds: ["text"],
      ...(registration.provider.staticCatalog
        ? {
            staticCatalog: async (ctx: UnifiedModelCatalogProviderContext) =>
              projectProviderCatalogResultToUnifiedTextRows({
                providerId: registration.provider.id,
                result: await registration.provider.staticCatalog!.run(ctx),
                source: "static",
              }),
          }
        : {}),
      ...(registration.provider.catalog
        ? {
            liveCatalog: async (ctx: UnifiedModelCatalogProviderContext) =>
              projectProviderCatalogResultToUnifiedTextRows({
                providerId: registration.provider.id,
                result: await registration.provider.catalog!.run(ctx),
                source: "live",
              }),
          }
        : {}),
    });
  };

  const registerSynthesizedMediaModelCatalogProvider = <TCapabilities>(registration: {
    record: PluginRecord;
    kind: MediaGenerationCatalogKind;
    provider: MediaGenerationCatalogProvider<TCapabilities>;
  }) => {
    registerModelCatalogProvider(registration.record, {
      provider: registration.provider.id,
      kinds: [registration.kind],
      staticCatalog: () =>
        synthesizeMediaGenerationCatalogEntries({
          kind: registration.kind,
          provider: registration.provider,
        }),
    });
  };

  const registerSynthesizedVoiceModelCatalogProvider = (registration: {
    record: PluginRecord;
    provider: VoiceModelProvider;
    capabilities: VoiceModelCapabilities;
    modes?: readonly string[];
  }) => {
    registerModelCatalogProvider(registration.record, {
      provider: registration.provider.id,
      kinds: ["voice"],
      staticCatalog: () =>
        synthesizeVoiceModelCatalogEntries({
          provider: registration.provider,
          capabilities: registration.capabilities,
          modes: registration.modes,
        }),
    });
  };

  return {
    registerModelCatalogProvider,
    registerSynthesizedTextModelCatalogProvider,
    registerSynthesizedMediaModelCatalogProvider,
    registerSynthesizedVoiceModelCatalogProvider,
  };
}
