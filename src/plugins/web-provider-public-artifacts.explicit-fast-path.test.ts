import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off the explicit bundled fast path");
  }),
}));

const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => {
  const providerBase = {
    label: "Fixture",
    hint: "fixture",
    envVars: ["FIXTURE_API_KEY"],
    placeholder: "fixture",
    signupUrl: "https://example.com",
    credentialPath: "plugins.entries.fixture.config.apiKey",
    getCredentialValue: () => undefined,
    setCredentialValue: () => ({}),
  };
  return {
    loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
      ({ dirName, artifactBasename }: { dirName: string; artifactBasename: string }) => {
        if (dirName === "brave" && artifactBasename === "web-search-contract-api.js") {
          return {
            createBraveWebSearchProvider: () => ({
              ...providerBase,
              id: "brave",
              createTool: () => null,
            }),
          };
        }
        if (dirName === "google" && artifactBasename === "web-search-provider.js") {
          return {
            createGeminiWebSearchProvider: () => ({
              ...providerBase,
              id: "gemini",
              createTool: () => ({ description: "fixture", parameters: {} }),
            }),
          };
        }
        if (dirName === "firecrawl" && artifactBasename === "web-fetch-contract-api.js") {
          return {
            createFirecrawlWebFetchProvider: () => ({
              ...providerBase,
              id: "firecrawl",
              createTool: () => null,
            }),
          };
        }
        if (dirName === "fuzzplugin" && artifactBasename === "web-search-contract-api.js") {
          return {
            createBrokenWebSearchProvider: () => {
              throw new Error("fuzzplugin provider factory failed");
            },
            createFuzzWebSearchProvider: () =>
              Object.create(null, {
                id: {
                  enumerable: true,
                  get() {
                    throw new Error("fuzzplugin provider id getter failed");
                  },
                },
                label: { enumerable: true, value: "Fuzz Provider" },
                hint: { enumerable: true, value: "fuzz" },
                envVars: { enumerable: true, value: ["FUZZ_API_KEY"] },
                placeholder: { enumerable: true, value: "fuzz" },
                signupUrl: { enumerable: true, value: "https://example.com/fuzz" },
                credentialPath: {
                  enumerable: true,
                  value: "plugins.entries.fuzzplugin.config.apiKey",
                },
                getCredentialValue: { enumerable: true, value: () => undefined },
                setCredentialValue: { enumerable: true, value: () => ({}) },
                createTool: { enumerable: true, value: () => null },
              }),
            createMockWebSearchProvider: () =>
              Object.create(null, {
                id: { enumerable: true, value: "mockplugin" },
                label: { enumerable: true, value: "Mock Provider" },
                hint: { enumerable: true, value: "mock" },
                envVars: { enumerable: true, value: ["MOCK_API_KEY"] },
                placeholder: { enumerable: true, value: "mock" },
                signupUrl: { enumerable: true, value: "https://example.com/mock" },
                credentialPath: {
                  enumerable: true,
                  value: "",
                },
                docsUrl: {
                  enumerable: true,
                  get() {
                    throw new Error("mockplugin docsUrl getter failed");
                  },
                },
                getCredentialValue: { enumerable: true, value: () => undefined },
                setCredentialValue: { enumerable: true, value: () => ({}) },
                createTool: {
                  enumerable: true,
                  value: () => ({ description: "mock", parameters: {} }),
                },
              }),
          };
        }
        throw new Error(
          `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
        );
      },
    ),
  };
});

vi.mock("./manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry: loadPluginManifestRegistryMock,
  };
});

vi.mock("./public-surface-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-surface-loader.js")>();
  return {
    ...actual,
    loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
  };
});

import { resolveBundledExplicitRuntimeWebSearchProvidersFromPublicArtifacts as resolveExplicitRuntimeWebSearchProviders } from "./web-provider-public-artifacts.explicit.js";
import {
  resolveBundledWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";

function expectSingleProvider<T>(providers: T[] | null | undefined): T {
  expect(providers).toHaveLength(1);
  const provider = providers?.[0];
  if (provider === undefined) {
    throw new Error("Expected one web provider");
  }
  return provider;
}

describe("web provider public artifacts explicit fast path", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockClear();
    loadBundledPluginPublicArtifactModuleSyncMock.mockClear();
  });

  it("resolves bundled web search providers by explicit plugin id without manifest scans", () => {
    const provider = expectSingleProvider(
      resolveBundledWebSearchProvidersFromPublicArtifacts({
        onlyPluginIds: ["brave"],
      }),
    );

    expect(provider.pluginId).toBe("brave");
    expect(provider.createTool({ config: {} as never })).toBeNull();
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "brave",
      artifactBasename: "web-search-contract-api.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves bundled runtime web search providers by explicit plugin id", () => {
    const provider = expectSingleProvider(
      resolveExplicitRuntimeWebSearchProviders({
        onlyPluginIds: ["google"],
      }),
    );

    expect(provider.pluginId).toBe("google");
    expect(provider.createTool({ config: {} as never })).toEqual({
      description: "fixture",
      parameters: {},
    });
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "google",
      artifactBasename: "web-search-provider.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves bundled web fetch providers by explicit plugin id without manifest scans", () => {
    const provider = expectSingleProvider(
      resolveBundledWebFetchProvidersFromPublicArtifacts({
        onlyPluginIds: ["firecrawl"],
      }),
    );

    expect(provider.pluginId).toBe("firecrawl");
    expect(provider.createTool({ config: {} as never })).toBeNull();
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "firecrawl",
      artifactBasename: "web-fetch-contract-api.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("skips unreadable bundled web search public artifact providers while preserving healthy entries", () => {
    const provider = expectSingleProvider(
      resolveBundledWebSearchProvidersFromPublicArtifacts({
        onlyPluginIds: ["fuzzplugin"],
      }),
    );

    expect(Object.getPrototypeOf(provider)).toBe(Object.prototype);
    expect(provider.id).toBe("mockplugin");
    expect(provider.pluginId).toBe("fuzzplugin");
    expect(provider.label).toBe("Mock Provider");
    expect(provider.envVars).toEqual(["MOCK_API_KEY"]);
    expect(provider.credentialPath).toBe("");
    expect("docsUrl" in provider).toBe(false);
    expect(provider.createTool({ config: {} as never })).toEqual({
      description: "mock",
      parameters: {},
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });
});
