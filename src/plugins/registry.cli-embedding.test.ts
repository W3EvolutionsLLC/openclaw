import { describe, expect, it } from "vitest";
import type { EmbeddingProviderAdapter } from "./embedding-providers.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

function diagnosticSummaries(diagnostics: readonly unknown[]) {
  return diagnostics.map((entry) => {
    const diagnostic = entry as { pluginId?: string; message?: string };
    return { pluginId: diagnostic.pluginId, message: diagnostic.message };
  });
}

describe("plugin registry CLI backend and embedding registrations", () => {
  it("rejects malformed CLI backend registrations without enumerating plugin state", () => {
    const pluginRegistry = createTestRegistry();
    const fuzzRecord = createPluginRecord({
      id: "fuzzplugin-cli-backend",
      name: "Fuzz Plugin CLI Backend",
      source: "/tmp/fuzzplugin-cli-backend/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const mockRecord = createPluginRecord({
      id: "mockplugin-cli-backend",
      name: "Mock Plugin CLI Backend",
      source: "/tmp/mockplugin-cli-backend/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    const unreadableId = Object.defineProperty({}, "id", {
      get() {
        throw new Error("fuzzplugin cli backend id getter failed");
      },
    });
    const unreadableConfig = Object.defineProperty(
      { id: "fuzzplugin-cli-unreadable-config" },
      "config",
      {
        get() {
          throw new Error("fuzzplugin cli backend config getter failed");
        },
      },
    );
    const backendWithExtraGetter = Object.defineProperty(
      { id: "mockplugin-cli", config: { command: "mock-cli" } },
      "extraCrash",
      {
        enumerable: true,
        get() {
          throw new Error("mockplugin cli backend extra getter should not be enumerated");
        },
      },
    );

    expect(() =>
      pluginRegistry.registerCliBackend(fuzzRecord, unreadableId as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerCliBackend(fuzzRecord, unreadableConfig as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerCliBackend(mockRecord, backendWithExtraGetter as never),
    ).not.toThrow();

    expect(pluginRegistry.registry.cliBackends?.map((entry) => entry.backend.id)).toEqual([
      "mockplugin-cli",
    ]);
    expect(pluginRegistry.registry.cliBackends?.[0]?.backend.config).toEqual({
      command: "mock-cli",
    });
    expect(mockRecord.cliBackendIds).toEqual(["mockplugin-cli"]);
    expect(diagnosticSummaries(pluginRegistry.registry.diagnostics)).toEqual([
      {
        pluginId: "fuzzplugin-cli-backend",
        message: "cli backend registration has unreadable field: id",
      },
      {
        pluginId: "fuzzplugin-cli-backend",
        message: "cli backend registration has unreadable field: config",
      },
    ]);
  });

  it("rejects malformed embedding providers while preserving healthy provider receivers", async () => {
    const pluginRegistry = createTestRegistry();
    const fuzzRecord = createPluginRecord({
      id: "fuzzplugin-embedding",
      name: "Fuzz Plugin Embedding",
      source: "/tmp/fuzzplugin-embedding/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
      contracts: {
        embeddingProviders: ["fuzzplugin-embedding-invalid-create"],
      },
    });
    const mockRecord = createPluginRecord({
      id: "mockplugin-embedding",
      name: "Mock Plugin Embedding",
      source: "/tmp/mockplugin-embedding/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
      contracts: {
        embeddingProviders: ["mockplugin-embedding"],
      },
    });

    const unreadableId = Object.defineProperty({}, "id", {
      get() {
        throw new Error("fuzzplugin embedding id getter failed");
      },
    });
    const invalidCreate = {
      id: "fuzzplugin-embedding-invalid-create",
      create: undefined,
    };
    class MockEmbeddingProvider {
      #marker = "private-state";
      id = "mockplugin-embedding";

      async create() {
        return { provider: this.#marker };
      }
    }

    expect(() =>
      pluginRegistry.registerEmbeddingProvider(fuzzRecord, unreadableId as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerEmbeddingProvider(
        fuzzRecord,
        invalidCreate as unknown as EmbeddingProviderAdapter,
      ),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerEmbeddingProvider(
        mockRecord,
        new MockEmbeddingProvider() as unknown as EmbeddingProviderAdapter,
      ),
    ).not.toThrow();

    expect(pluginRegistry.registry.embeddingProviders.map((entry) => entry.provider.id)).toEqual([
      "mockplugin-embedding",
    ]);
    await expect(
      pluginRegistry.registry.embeddingProviders[0]?.provider.create({} as never),
    ).resolves.toEqual({ provider: "private-state" });
    expect(mockRecord.embeddingProviderIds).toEqual(["mockplugin-embedding"]);
    expect(diagnosticSummaries(pluginRegistry.registry.diagnostics)).toEqual([
      {
        pluginId: "fuzzplugin-embedding",
        message: "embedding provider registration has unreadable field: id",
      },
      {
        pluginId: "fuzzplugin-embedding",
        message:
          "embedding provider registration missing or invalid create: fuzzplugin-embedding-invalid-create",
      },
    ]);
  });
});
