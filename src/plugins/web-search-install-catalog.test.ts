import { beforeEach, describe, expect, it, vi } from "vitest";

const catalogMocks = vi.hoisted(() => ({
  getOfficialExternalPluginCatalogManifest: vi.fn((entry: { manifest?: unknown }) => {
    return entry.manifest;
  }),
  listOfficialExternalPluginCatalogEntries: vi.fn<() => unknown[]>(() => []),
  resolveOfficialExternalPluginInstall: vi.fn((entry: { install?: unknown }) => entry.install),
  resolveOfficialExternalPluginLabel: vi.fn((entry: { label?: string }) => entry.label ?? "Plugin"),
}));

vi.mock("./official-external-plugin-catalog.js", () => ({
  getOfficialExternalPluginCatalogManifest: catalogMocks.getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries: catalogMocks.listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginInstall: catalogMocks.resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel: catalogMocks.resolveOfficialExternalPluginLabel,
}));

import {
  resolveWebSearchInstallCatalogEntries,
  resolveWebSearchInstallCatalogEntry,
} from "./web-search-install-catalog.js";

function createMockProvider(params?: { id?: string; label?: string; pluginId?: string }) {
  const pluginId = params?.pluginId ?? "mockplugin";
  return {
    id: params?.id ?? "mocksearch",
    label: params?.label ?? "Mock Search",
    hint: "Mock search setup",
    envVars: ["MOCK_SEARCH_API_KEY"],
    placeholder: "mock-key",
    signupUrl: `https://example.invalid/${pluginId}`,
    credentialPath: `plugins.entries.${pluginId}.config.webSearch.apiKey`,
    onboardingScopes: ["text-inference"],
  };
}

describe("web search install catalog", () => {
  beforeEach(() => {
    catalogMocks.getOfficialExternalPluginCatalogManifest.mockClear();
    catalogMocks.listOfficialExternalPluginCatalogEntries.mockReset();
    catalogMocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([]);
    catalogMocks.resolveOfficialExternalPluginInstall.mockClear();
    catalogMocks.resolveOfficialExternalPluginLabel.mockClear();
  });

  it("skips unreadable provider rows while preserving healthy install catalog entries", () => {
    const unreadableProvider = {
      label: "Fuzz Search",
      hint: "Broken search setup",
      envVars: ["FUZZ_SEARCH_API_KEY"],
      placeholder: "fuzz-key",
      signupUrl: "https://example.invalid/fuzzplugin",
    };
    Object.defineProperty(unreadableProvider, "id", {
      get() {
        throw new Error("fuzzplugin search provider id failed");
      },
    });
    catalogMocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        label: "Fuzz Plugin",
        install: { npmSpec: "@openclaw/plugin-fuzz-search" },
        manifest: {
          plugin: { id: "fuzzplugin" },
          webSearchProviders: [unreadableProvider],
        },
      },
      {
        name: "Fuzz Label Plugin",
        install: { npmSpec: "@openclaw/plugin-fuzz-label-search" },
        manifest: {
          plugin: Object.defineProperty({ id: "fuzzlabelplugin" }, "label", {
            get() {
              throw new Error("fuzzplugin search plugin label failed");
            },
          }),
          webSearchProviders: [
            createMockProvider({
              id: "fuzzlabelsearch",
              label: "Fuzz Label Search",
              pluginId: "fuzzlabelplugin",
            }),
          ],
        },
      },
      {
        name: "Mock Plugin",
        install: { npmSpec: "@openclaw/plugin-mock-search" },
        manifest: {
          plugin: { id: "mockplugin" },
          webSearchProviders: [createMockProvider()],
        },
      },
    ]);

    expect(
      resolveWebSearchInstallCatalogEntries().map((entry) => ({
        pluginId: entry.pluginId,
        providerId: entry.provider.id,
        label: entry.label,
      })),
    ).toEqual([
      {
        pluginId: "fuzzlabelplugin",
        providerId: "fuzzlabelsearch",
        label: "Fuzz Label Plugin",
      },
      { pluginId: "mockplugin", providerId: "mocksearch", label: "Mock Plugin" },
    ]);
    expect(resolveWebSearchInstallCatalogEntry({ providerId: "mocksearch" })).toMatchObject({
      pluginId: "mockplugin",
      provider: { id: "mocksearch" },
      trustedSourceLinkedOfficialInstall: true,
    });
  });
});
