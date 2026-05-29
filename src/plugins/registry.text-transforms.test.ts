import { describe, expect, it } from "vitest";
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

describe("plugin registry text transform registrations", () => {
  it("rejects malformed standalone text transforms without retaining plugin state", () => {
    const pluginRegistry = createTestRegistry();
    const fuzzRecord = createPluginRecord({
      id: "fuzzplugin-text-transforms",
      name: "Fuzz Plugin Text Transforms",
      source: "/tmp/fuzzplugin-text-transforms/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const mockRecord = createPluginRecord({
      id: "mockplugin-text-transforms",
      name: "Mock Plugin Text Transforms",
      source: "/tmp/mockplugin-text-transforms/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    const unreadableInput = Object.defineProperty({}, "input", {
      get() {
        throw new Error("fuzzplugin text transform input getter failed");
      },
    });
    const revokedInput = Proxy.revocable([], {});
    revokedInput.revoke();
    const invalidOutput = { output: "not-array" };
    const unreadableReplacement = {
      input: [
        Object.defineProperty({}, "from", {
          get() {
            throw new Error("fuzzplugin text transform replacement getter failed");
          },
        }),
      ],
    };
    const proxiedRegExpReplacement = {
      input: [{ from: new Proxy(/proxy basket/g, {}), to: "ignored" }],
    };
    const input = [{ from: "red basket", to: "blue basket" }];
    const output = [{ from: /blue basket/g, to: "red basket" }];
    const originalOutputFrom = output[0]?.from;
    const healthyTransforms = Object.defineProperty({ input, output }, "extraCrash", {
      enumerable: true,
      get() {
        throw new Error("mockplugin text transform extra getter should not be enumerated");
      },
    });

    expect(() =>
      pluginRegistry.registerTextTransforms(fuzzRecord, unreadableInput as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerTextTransforms(fuzzRecord, { input: revokedInput.proxy } as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerTextTransforms(fuzzRecord, invalidOutput as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerTextTransforms(fuzzRecord, unreadableReplacement as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerTextTransforms(fuzzRecord, proxiedRegExpReplacement as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerTextTransforms(mockRecord, healthyTransforms),
    ).not.toThrow();

    input.push({ from: "late mutation", to: "ignored" });
    output.length = 0;

    expect(pluginRegistry.registry.textTransforms).toHaveLength(1);
    expect(pluginRegistry.registry.textTransforms[0]).toMatchObject({
      pluginId: "mockplugin-text-transforms",
      transforms: {
        input: [{ from: "red basket", to: "blue basket" }],
        output: [{ from: /blue basket/g, to: "red basket" }],
      },
    });
    expect(pluginRegistry.registry.textTransforms[0]?.transforms.output?.[0]?.from).not.toBe(
      originalOutputFrom,
    );
    expect(diagnosticSummaries(pluginRegistry.registry.diagnostics)).toEqual([
      {
        pluginId: "fuzzplugin-text-transforms",
        message: "text transform registration has unreadable field: input",
      },
      {
        pluginId: "fuzzplugin-text-transforms",
        message: "text transform registration has unreadable field: input",
      },
      {
        pluginId: "fuzzplugin-text-transforms",
        message: "text transform registration has invalid output replacements",
      },
      {
        pluginId: "fuzzplugin-text-transforms",
        message: "text transform registration has unreadable field: input",
      },
      {
        pluginId: "fuzzplugin-text-transforms",
        message: "text transform registration has invalid input replacements",
      },
    ]);
  });

  it("rejects malformed CLI backend text transforms while snapshotting healthy backends", () => {
    const pluginRegistry = createTestRegistry();
    const fuzzRecord = createPluginRecord({
      id: "fuzzplugin-cli-text-transforms",
      name: "Fuzz Plugin CLI Text Transforms",
      source: "/tmp/fuzzplugin-cli-text-transforms/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const mockRecord = createPluginRecord({
      id: "mockplugin-cli-text-transforms",
      name: "Mock Plugin CLI Text Transforms",
      source: "/tmp/mockplugin-cli-text-transforms/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    const unreadableTextTransforms = Object.defineProperty({}, "input", {
      get() {
        throw new Error("fuzzplugin cli text transform input getter failed");
      },
    });
    const input = [{ from: "alpha", to: "beta" }];

    expect(() =>
      pluginRegistry.registerCliBackend(fuzzRecord, {
        id: "fuzzplugin-cli-text",
        config: { command: "fuzz-cli" },
        textTransforms: unreadableTextTransforms,
      } as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerCliBackend(mockRecord, {
        id: "mockplugin-cli-text",
        config: { command: "mock-cli" },
        textTransforms: { input },
      } as never),
    ).not.toThrow();

    input.push({ from: "late mutation", to: "ignored" });

    expect(pluginRegistry.registry.cliBackends?.map((entry) => entry.backend)).toEqual([
      {
        id: "mockplugin-cli-text",
        config: { command: "mock-cli" },
        textTransforms: { input: [{ from: "alpha", to: "beta" }] },
      },
    ]);
    expect(diagnosticSummaries(pluginRegistry.registry.diagnostics)).toEqual([
      {
        pluginId: "fuzzplugin-cli-text-transforms",
        message: "cli backend textTransforms has unreadable field: input",
      },
    ]);
  });
});
