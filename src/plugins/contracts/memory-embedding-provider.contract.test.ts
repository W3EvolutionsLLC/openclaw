import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { getRegisteredMemoryEmbeddingProvider } from "../memory-embedding-providers.js";
import { createPluginRecord } from "../status.test-helpers.js";

describe("memory embedding provider registration", () => {
  it("rejects non-memory plugins that did not declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "not-memory",
      name: "Not Memory",
      register(api) {
        api.registerMemoryEmbeddingProvider({
          id: "forbidden",
          create: async () => ({ provider: null }),
        });
      },
    });

    expect(getRegisteredMemoryEmbeddingProvider("forbidden")).toBeUndefined();
    const diagnostic = registry.registry.diagnostics.find(
      (entry) => entry.pluginId === "not-memory",
    );
    expect(diagnostic?.message).toBe(
      "plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: forbidden",
    );
  });

  it("allows non-memory plugins that declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "external-vector",
      name: "External Vector",
      contracts: {
        memoryEmbeddingProviders: ["external-vector"],
      },
      register(api) {
        api.registerMemoryEmbeddingProvider({
          id: "external-vector",
          create: async () => ({ provider: null }),
        });
      },
    });

    const provider = getRegisteredMemoryEmbeddingProvider("external-vector");
    expect(provider?.adapter.id).toBe("external-vector");
    expect(provider?.ownerPluginId).toBe("external-vector");
  });

  it("records the owning memory plugin id for registered adapters", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "memory-core",
      name: "Memory Core",
      kind: "memory",
      register(api) {
        api.registerMemoryEmbeddingProvider({
          id: "demo-embedding",
          create: async () => ({ provider: null }),
        });
      },
    });

    const provider = getRegisteredMemoryEmbeddingProvider("demo-embedding");
    expect(provider?.adapter.id).toBe("demo-embedding");
    expect(provider?.ownerPluginId).toBe("memory-core");
  });

  it("rejects malformed adapters without aborting sibling memory providers", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const unreadableId = Object.defineProperty({}, "id", {
      get() {
        throw new Error("fuzzplugin memory embedding id getter failed");
      },
    });
    const invalidCreate = {
      id: "fuzzplugin-memory-invalid-create",
      create: undefined,
    };

    registerVirtualTestPlugin({
      registry,
      config,
      id: "fuzzplugin-memory",
      name: "Fuzz Plugin Memory",
      kind: "memory",
      register(api) {
        api.registerMemoryEmbeddingProvider(unreadableId as never);
        api.registerMemoryEmbeddingProvider(invalidCreate as never);
      },
    });

    class MockMemoryEmbeddingProvider {
      #marker = "private-state";
      id = "mockplugin-memory";

      async create() {
        return { provider: this.#marker };
      }
    }

    registerVirtualTestPlugin({
      registry,
      config,
      id: "mockplugin-memory",
      name: "Mock Plugin Memory",
      kind: "memory",
      register(api) {
        api.registerMemoryEmbeddingProvider(
          new MockMemoryEmbeddingProvider() as unknown as Parameters<
            typeof api.registerMemoryEmbeddingProvider
          >[0],
        );
      },
    });

    const provider = getRegisteredMemoryEmbeddingProvider("mockplugin-memory");
    expect(provider?.adapter.id).toBe("mockplugin-memory");
    expect(provider?.ownerPluginId).toBe("mockplugin-memory");
    await expect(provider?.adapter.create({} as never)).resolves.toEqual({
      provider: "private-state",
    });
    expect(registry.registry.memoryEmbeddingProviders.map((entry) => entry.provider.id)).toEqual([
      "mockplugin-memory",
    ]);
    expect(
      registry.registry.diagnostics
        .filter((entry) => entry.pluginId === "fuzzplugin-memory")
        .map((entry) => entry.message),
    ).toEqual([
      "memory embedding provider registration has unreadable field: id",
      "memory embedding provider registration missing or invalid create: fuzzplugin-memory-invalid-create",
    ]);
  });

  it("keeps companion embedding providers available during tool discovery", () => {
    const { config, registry } = createPluginRegistryFixture();
    const record = createPluginRecord({
      id: "tool-discovery-memory",
      name: "Tool Discovery Memory",
      kind: "memory",
      contracts: { tools: ["memory_recall"] },
    });
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, {
      config,
      registrationMode: "tool-discovery",
    });

    api.registerMemoryEmbeddingProvider({
      id: "tool-discovery-embedding",
      create: async () => ({ provider: null }),
    });
    api.registerTool({
      name: "memory_recall",
      label: "Memory Recall",
      description: "Recall memory",
      parameters: {},
      execute: async () => ({ content: [], details: {} }),
    });

    const provider = getRegisteredMemoryEmbeddingProvider("tool-discovery-embedding");
    expect(provider?.adapter.id).toBe("tool-discovery-embedding");
    expect(provider?.ownerPluginId).toBe("tool-discovery-memory");
    expect(registry.registry.tools).toHaveLength(1);
    expect(registry.registry.tools[0]?.pluginId).toBe("tool-discovery-memory");
    expect(registry.registry.tools[0]?.names).toEqual(["memory_recall"]);
  });
});
