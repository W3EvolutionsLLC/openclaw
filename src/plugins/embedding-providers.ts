import type {
  EmbeddingProviderAdapter,
  RegisteredEmbeddingProvider,
} from "./embedding-provider-types.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

export type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
  EmbeddingProviderRuntime,
  RegisteredEmbeddingProvider,
} from "./embedding-provider-types.js";

const EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.embeddingProviders");
const CORE_EMBEDDING_PROVIDERS: RegisteredEmbeddingProvider[] = [
  {
    adapter: openAICompatibleEmbeddingProviderAdapter,
    ownerPluginId: "core",
  },
];

function getEmbeddingProviders(): Map<string, RegisteredEmbeddingProvider> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[EMBEDDING_PROVIDERS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, RegisteredEmbeddingProvider>;
  }
  const created = new Map<string, RegisteredEmbeddingProvider>();
  globalStore[EMBEDDING_PROVIDERS_KEY] = created;
  return created;
}

function readEmbeddingProviderAdapterId(adapter: EmbeddingProviderAdapter): string | undefined {
  try {
    const id = (adapter as { id?: unknown }).id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export function registerEmbeddingProvider(
  adapter: EmbeddingProviderAdapter,
  options?: { ownerPluginId?: string },
): void {
  const id = readEmbeddingProviderAdapterId(adapter);
  if (!id) {
    return;
  }
  getEmbeddingProviders().set(id, {
    adapter,
    ownerPluginId: options?.ownerPluginId,
  });
}

export function getRegisteredEmbeddingProvider(
  id: string,
): RegisteredEmbeddingProvider | undefined {
  return (
    getEmbeddingProviders().get(id) ??
    CORE_EMBEDDING_PROVIDERS.find((entry) => readEmbeddingProviderAdapterId(entry.adapter) === id)
  );
}

export function getEmbeddingProvider(id: string): EmbeddingProviderAdapter | undefined {
  return getRegisteredEmbeddingProvider(id)?.adapter;
}

export function listRegisteredEmbeddingProviders(): RegisteredEmbeddingProvider[] {
  const merged = new Map<string, RegisteredEmbeddingProvider>();
  for (const entry of CORE_EMBEDDING_PROVIDERS) {
    const id = readEmbeddingProviderAdapterId(entry.adapter);
    if (id) {
      merged.set(id, entry);
    }
  }
  for (const entry of getEmbeddingProviders().values()) {
    const id = readEmbeddingProviderAdapterId(entry.adapter);
    if (id) {
      merged.set(id, entry);
    }
  }
  return Array.from(merged.values());
}

export function listEmbeddingProviders(): EmbeddingProviderAdapter[] {
  return listRegisteredEmbeddingProviders().map((entry) => entry.adapter);
}

export function restoreEmbeddingProviders(adapters: EmbeddingProviderAdapter[]): void {
  getEmbeddingProviders().clear();
  for (const adapter of adapters) {
    registerEmbeddingProvider(adapter);
  }
}

export function restoreRegisteredEmbeddingProviders(entries: RegisteredEmbeddingProvider[]): void {
  getEmbeddingProviders().clear();
  for (const entry of entries) {
    registerEmbeddingProvider(entry.adapter, {
      ownerPluginId: entry.ownerPluginId,
    });
  }
}

export function clearEmbeddingProviders(): void {
  getEmbeddingProviders().clear();
}

export const resetEmbeddingProviders = clearEmbeddingProviders;
