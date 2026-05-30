import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_EXTENSION_RUNTIME_ID,
  listCodexAppServerExtensionFactories,
} from "./codex-app-server-extension-factory.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginCodexAppServerExtensionFactoryRegistration } from "./registry-types.js";
import { setActivePluginRegistry } from "./runtime.js";

describe("listCodexAppServerExtensionFactories", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("skips unreadable synthetic factory entries while preserving healthy factories", () => {
    const registry = createEmptyPluginRegistry();
    const healthyFactory: CodexAppServerExtensionFactory = vi.fn();
    const unreadableEntry = {
      pluginId: "fuzzplugin",
      pluginName: "Fuzz Plugin",
      rawFactory: vi.fn(),
      source: "synthetic",
    } as PluginCodexAppServerExtensionFactoryRegistration;
    Object.defineProperty(unreadableEntry, "factory", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin codex app-server factory read failed");
      },
    });
    registry.codexAppServerExtensionFactories.push(unreadableEntry, {
      pluginId: "mockplugin",
      pluginName: "Mock Plugin",
      rawFactory: healthyFactory,
      factory: healthyFactory,
      source: "synthetic",
    });

    setActivePluginRegistry(registry);

    expect(listCodexAppServerExtensionFactories()).toEqual([healthyFactory]);
  });

  it("keeps the Codex app-server runtime id stable", () => {
    expect(CODEX_APP_SERVER_EXTENSION_RUNTIME_ID).toBe("codex-app-server");
  });
});
