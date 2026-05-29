import { describe, expect, it, vi } from "vitest";
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

describe("plugin registry gateway method registrations", () => {
  it("rejects malformed gateway method registrations without aborting siblings", async () => {
    const pluginRegistry = createTestRegistry();
    const fuzzRecord = createPluginRecord({
      id: "fuzzplugin-gateway-method",
      name: "Fuzz Plugin Gateway Method",
      source: "/tmp/fuzzplugin-gateway-method/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const mockRecord = createPluginRecord({
      id: "mockplugin-gateway-method",
      name: "Mock Plugin Gateway Method",
      source: "/tmp/mockplugin-gateway-method/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    const unreadableMethod = Object.defineProperty({}, "trim", {
      get() {
        throw new Error("fuzzplugin gateway method trim getter failed");
      },
    }) as string;
    const unreadableScopeOptions = Object.defineProperty({}, "scope", {
      get() {
        throw new Error("fuzzplugin gateway method scope getter failed");
      },
    });

    expect(() =>
      pluginRegistry.registerGatewayMethod(fuzzRecord, unreadableMethod, vi.fn() as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerGatewayMethod(
        fuzzRecord,
        "fuzzplugin.gateway.unreadableScope",
        vi.fn() as never,
        unreadableScopeOptions as never,
      ),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerGatewayMethod(
        fuzzRecord,
        "fuzzplugin.gateway.invalidScope",
        vi.fn() as never,
        { scope: "plugin.root" } as never,
      ),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerGatewayMethod(
        fuzzRecord,
        "fuzzplugin.gateway.invalidHandler",
        undefined as never,
      ),
    ).not.toThrow();

    const responses: unknown[] = [];
    pluginRegistry.registerGatewayMethod(
      mockRecord,
      "mockplugin.gateway.status",
      async () => ({ ok: true }),
      { scope: "operator.read" },
    );
    await pluginRegistry.registry.gatewayHandlers["mockplugin.gateway.status"]?.({
      params: {},
      respond: (ok: boolean, payload: unknown, error?: unknown) =>
        responses.push({ ok, payload, error }),
    } as never);

    expect(Object.keys(pluginRegistry.registry.gatewayHandlers)).toEqual([
      "mockplugin.gateway.status",
    ]);
    expect(pluginRegistry.registry.gatewayMethodDescriptors).toMatchObject([
      {
        name: "mockplugin.gateway.status",
        scope: "operator.read",
        owner: { kind: "plugin", pluginId: "mockplugin-gateway-method" },
      },
    ]);
    expect(responses).toEqual([{ ok: true, payload: { ok: true }, error: undefined }]);
    expect(diagnosticSummaries(pluginRegistry.registry.diagnostics)).toEqual([
      {
        pluginId: "fuzzplugin-gateway-method",
        message: "gateway method registration missing or invalid method",
      },
      {
        pluginId: "fuzzplugin-gateway-method",
        message:
          "gateway method registration has unreadable field: scope (fuzzplugin.gateway.unreadableScope)",
      },
      {
        pluginId: "fuzzplugin-gateway-method",
        message: "gateway method registration has invalid scope: fuzzplugin.gateway.invalidScope",
      },
      {
        pluginId: "fuzzplugin-gateway-method",
        message:
          "gateway method registration missing or invalid handler: fuzzplugin.gateway.invalidHandler",
      },
    ]);
  });
});
