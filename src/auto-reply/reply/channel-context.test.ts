import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolveChannelAccountId } from "./channel-context.js";
import { resolveConversationBindingAccountIdFromMessage } from "./conversation-binding-input.js";

function installHostileChannelRegistry() {
  const registry = createTestRegistry([]);
  const hostileEntry = Object.defineProperty(
    {
      pluginId: "unreadable",
      source: "test",
    },
    "plugin",
    {
      get() {
        throw new Error("unreadable plugin entry");
      },
    },
  );
  registry.channels = [
    hostileEntry,
    {
      pluginId: "mockplugin",
      source: "test",
      plugin: createChannelTestPluginBase({
        id: "mockplugin",
        config: { defaultAccountId: () => "work" },
      }),
    },
  ] as never;
  setActivePluginRegistry(registry);
}

function installThrowingDefaultAccountRegistry() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "mockplugin",
        source: "test",
        plugin: createChannelTestPluginBase({
          id: "mockplugin",
          config: {
            defaultAccountId: () => {
              throw new Error("default account unavailable");
            },
          },
        }),
      },
    ]),
  );
}

describe("auto-reply channel context", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("skips unreadable registry entries when resolving default account ids", () => {
    const cfg = {} as OpenClawConfig;
    installHostileChannelRegistry();

    expect(
      resolveChannelAccountId({
        cfg,
        ctx: { OriginatingChannel: "mockplugin" },
        command: {},
      }),
    ).toBe("work");
    expect(
      resolveConversationBindingAccountIdFromMessage({
        cfg,
        ctx: { OriginatingChannel: "mockplugin" },
      }),
    ).toBe("work");
  });

  it("does not hide target channel default account resolver failures", () => {
    installThrowingDefaultAccountRegistry();

    expect(() =>
      resolveChannelAccountId({
        cfg: {} as OpenClawConfig,
        ctx: { OriginatingChannel: "mockplugin" },
        command: {},
      }),
    ).toThrow("default account unavailable");
  });
});
