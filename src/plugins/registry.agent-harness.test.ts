import { afterEach, describe, expect, it } from "vitest";
import {
  clearAgentHarnesses,
  getAgentHarness,
  registerAgentHarness as registerGlobalAgentHarness,
} from "../agents/harness/registry.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry(params?: { activateGlobalSideEffects?: boolean }) {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: params?.activateGlobalSideEffects ?? false,
  });
}

function diagnosticSummaries(diagnostics: readonly unknown[]) {
  return diagnostics.map((entry) => {
    const diagnostic = entry as { pluginId?: string; message?: string };
    return { pluginId: diagnostic.pluginId, message: diagnostic.message };
  });
}

describe("plugin registry agent harness registrations", () => {
  afterEach(() => {
    clearAgentHarnesses();
  });

  it("preserves harness instances while guarding harness fields", async () => {
    class StatefulHarness {
      #runs = 0;
      id = "stateful-harness";
      label = "Stateful Harness";

      supports() {
        return { supported: true as const };
      }

      async runAttempt() {
        this.#runs += 1;
        return { ok: false, error: "unused" } as never;
      }

      get runs() {
        return this.#runs;
      }
    }
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "stateful-harness-owner",
      name: "Stateful Harness Owner",
      source: "/tmp/stateful-harness-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const harness = new StatefulHarness();

    pluginRegistry.registerAgentHarness(record, harness);

    const storedHarness = pluginRegistry.registry.agentHarnesses[0]?.harness;
    await expect(storedHarness?.runAttempt({} as never)).resolves.toEqual({
      ok: false,
      error: "unused",
    });
    expect(harness.runs).toBe(1);
  });

  it("preserves harness instances in the global harness registry", async () => {
    class StatefulHarness {
      #runs = 0;
      id = "stateful-global-harness";
      label = "Stateful Global Harness";

      supports() {
        return { supported: true as const };
      }

      async runAttempt() {
        this.#runs += 1;
        return { ok: false, error: "unused" } as never;
      }

      get runs() {
        return this.#runs;
      }
    }
    const pluginRegistry = createTestRegistry({ activateGlobalSideEffects: true });
    const record = createPluginRecord({
      id: "stateful-global-harness-owner",
      name: "Stateful Global Harness Owner",
      source: "/tmp/stateful-global-harness-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const harness = new StatefulHarness();

    pluginRegistry.registerAgentHarness(record, harness);

    const globalHarness = getAgentHarness("stateful-global-harness");
    await expect(globalHarness?.runAttempt({} as never)).resolves.toEqual({
      ok: false,
      error: "unused",
    });
    expect(harness.runs).toBe(1);
  });

  it("normalizes frozen direct global harness registrations with bound methods", async () => {
    let runs = 0;
    const harness = Object.freeze({
      id: " frozen-harness ",
      label: "Frozen Harness",
      state: "ready",
      supports(this: { id: string; pluginId?: string; state?: string }) {
        return this.id === "frozen-harness" &&
          this.pluginId === "mockplugin-harness-owner" &&
          this.state === "ready"
          ? { supported: true as const }
          : { supported: false as const };
      },
      async runAttempt(this: { id: string; pluginId?: string; state?: string }) {
        if (
          this.id !== "frozen-harness" ||
          this.pluginId !== "mockplugin-harness-owner" ||
          this.state !== "ready"
        ) {
          throw new Error("global harness receiver was not normalized");
        }
        runs += 1;
        return { ok: false, error: "unused" } as never;
      },
    });

    registerGlobalAgentHarness(harness, { ownerPluginId: "mockplugin-harness-owner" });

    const globalHarness = getAgentHarness("frozen-harness");
    expect(globalHarness?.id).toBe("frozen-harness");
    expect(globalHarness?.pluginId).toBe("mockplugin-harness-owner");
    await expect(globalHarness?.runAttempt({} as never)).resolves.toEqual({
      ok: false,
      error: "unused",
    });
    expect(runs).toBe(1);
  });

  it("stores stable harness metadata after bounded reads", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "mockplugin-harness-owner",
      name: "Mock Plugin Harness Owner",
      source: "/tmp/mockplugin-harness-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    let idReads = 0;
    const harness = {
      label: "Mock Plugin Harness",
      get id() {
        idReads += 1;
        if (idReads > 1) {
          throw new Error("mockplugin harness id getter read twice");
        }
        return "mockplugin-stable-harness";
      },
      supports: () => ({ supported: true }),
      runAttempt: async () => ({ ok: false, error: "unused" }) as never,
    } as never;

    pluginRegistry.registerAgentHarness(record, harness);
    pluginRegistry.registerAgentHarness(record, {
      id: "mockplugin-sibling-harness",
      label: "Mock Plugin Sibling Harness",
      supports: () => ({ supported: true }),
      runAttempt: async () => ({ ok: false, error: "unused" }) as never,
    });

    expect(idReads).toBe(1);
    expect(pluginRegistry.registry.agentHarnesses.map((entry) => entry.harness.id)).toEqual([
      "mockplugin-stable-harness",
      "mockplugin-sibling-harness",
    ]);
  });

  it("rejects unreadable harness ids without aborting sibling harnesses", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "fuzzplugin-harness",
      name: "Fuzz Plugin Harness",
      source: "/tmp/fuzzplugin-harness/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const harness = {
      label: "Broken Harness",
      supports: () => ({ supported: true }),
      runAttempt: async () => ({ ok: false, error: "unused" }),
      get id() {
        throw new Error("fuzzplugin harness id getter failed");
      },
    } as never;

    pluginRegistry.registerAgentHarness(record, harness);
    pluginRegistry.registerAgentHarness(record, {
      id: "mockplugin-harness",
      label: "Mock Plugin Harness",
      supports: () => ({ supported: true }),
      runAttempt: async () => ({ ok: false, error: "unused" }) as never,
    });

    expect(record.agentHarnessIds).toEqual(["mockplugin-harness"]);
    expect(pluginRegistry.registry.agentHarnesses.map((entry) => entry.harness.id)).toEqual([
      "mockplugin-harness",
    ]);
    expect(diagnosticSummaries(pluginRegistry.registry.diagnostics)).toContainEqual({
      pluginId: "fuzzplugin-harness",
      message: "agent harness registration has unreadable field: id",
    });
  });
});
