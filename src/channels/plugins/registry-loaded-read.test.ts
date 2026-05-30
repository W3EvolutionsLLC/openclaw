import { afterEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { getLoadedChannelPluginForRead } from "./registry-loaded-read.js";
import type { ChannelPlugin } from "./types.plugin.js";

describe("loaded channel plugin read lookup", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("skips unreadable loaded channel registry entries while returning healthy plugins", () => {
    const healthyPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "mockplugin-chat",
        label: "Mock Plugin Chat",
      }),
      messaging: {
        parseExplicitTarget: () => ({ to: "room-alpha" }),
      },
    };
    const registry = createTestRegistry([
      {
        pluginId: healthyPlugin.id,
        source: "test",
        plugin: healthyPlugin,
      },
    ]);
    const unreadableEntry = Object.defineProperty(
      { pluginId: "fuzzplugin-entry", source: "test" },
      "plugin",
      {
        enumerable: true,
        get() {
          throw new Error("fuzzplugin channel entry unreadable");
        },
      },
    );
    const unreadablePluginId = Object.defineProperty({ meta: { id: "fuzzplugin-chat" } }, "id", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin channel id unreadable");
      },
    });
    registry.channels.unshift(
      unreadableEntry as never,
      { pluginId: "fuzzplugin-chat", source: "test", plugin: unreadablePluginId } as never,
    );
    setActivePluginRegistry(registry);

    expect(getLoadedChannelPluginForRead("mockplugin-chat")).toBe(healthyPlugin);
    expect(getLoadedChannelPluginForRead("fuzzplugin-chat")).toBeUndefined();
  });
});
