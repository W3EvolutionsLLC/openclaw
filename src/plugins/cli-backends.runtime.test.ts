import { afterEach, describe, expect, it } from "vitest";
import type { CliBackendPlugin } from "./cli-backend.types.js";
import { resolveRuntimeCliBackends } from "./cli-backends.runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

describe("resolveRuntimeCliBackends", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("skips unreadable CLI backend entries while preserving healthy backends", () => {
    const unreadableId = Object.create(null, {
      id: {
        enumerable: true,
        get() {
          throw new Error("fuzzplugin cli backend id getter failed");
        },
      },
      config: {
        enumerable: true,
        value: { command: "fuzz-cli" },
      },
    }) as CliBackendPlugin;
    const unreadableConfig = Object.create(null, {
      id: {
        enumerable: true,
        value: "fuzzplugin-cli-config",
      },
      config: {
        enumerable: true,
        get() {
          throw new Error("fuzzplugin cli backend config getter failed");
        },
      },
    }) as CliBackendPlugin;
    const unreadableCommandConfig = {
      id: "fuzzplugin-cli-command",
      config: Object.create(null, {
        command: {
          enumerable: true,
          get() {
            throw new Error("fuzzplugin cli backend command getter failed");
          },
        },
      }),
    } as CliBackendPlugin;
    const healthy = Object.create(null, {
      id: {
        enumerable: true,
        value: "mockplugin-cli",
      },
      config: {
        enumerable: true,
        value: Object.create(null, {
          command: {
            enumerable: true,
            value: "mock-cli",
          },
          args: {
            enumerable: true,
            get() {
              throw new Error("mockplugin cli backend args getter failed");
            },
          },
        }),
      },
      bundleMcp: {
        enumerable: true,
        value: true,
      },
      liveTest: {
        enumerable: true,
        get() {
          throw new Error("mockplugin cli backend liveTest getter failed");
        },
      },
    }) as CliBackendPlugin;
    const registry = createEmptyPluginRegistry();
    registry.cliBackends.push(
      { pluginId: "fuzzplugin", backend: unreadableId, source: "test" },
      { pluginId: "fuzzplugin", backend: unreadableConfig, source: "test" },
      { pluginId: "fuzzplugin", backend: unreadableCommandConfig, source: "test" },
      { pluginId: "mockplugin", backend: healthy, source: "test" },
    );
    setActivePluginRegistry(registry);

    const backends = resolveRuntimeCliBackends();

    expect(backends).toEqual([
      {
        id: "mockplugin-cli",
        config: { command: "mock-cli" },
        bundleMcp: true,
        pluginId: "mockplugin",
      },
    ]);
    expect(Object.getPrototypeOf(backends[0])).toBe(Object.prototype);
  });
});
