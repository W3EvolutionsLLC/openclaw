import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { pluginHostHookHandlers } from "./plugin-host-hooks.js";

function respondCall(respond: ReturnType<typeof vi.fn>) {
  const call = respond.mock.calls[0] as [boolean, unknown?, unknown?] | undefined;
  if (!call) {
    throw new Error("expected respond call");
  }
  return call;
}

describe("plugin host hook gateway handlers", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("skips unreadable Control UI descriptors while preserving healthy siblings", async () => {
    const registry = createEmptyPluginRegistry();
    const unreadableDescriptor = Object.create(null, {
      id: {
        enumerable: true,
        get() {
          throw new Error("fuzzplugin descriptor id is unreadable");
        },
      },
      surface: { enumerable: true, value: "session" },
      label: { enumerable: true, value: "Fuzz Descriptor" },
    });
    const healthyDescriptor = Object.create(null, {
      id: { enumerable: true, value: "mockplugin-card" },
      surface: { enumerable: true, value: "session" },
      label: { enumerable: true, value: "Mock Card" },
      description: {
        enumerable: true,
        get() {
          throw new Error("mockplugin descriptor description is unreadable");
        },
      },
      schema: {
        enumerable: true,
        get() {
          throw new Error("mockplugin descriptor schema is unreadable");
        },
      },
      requiredScopes: {
        enumerable: true,
        value: ["operator.read"],
      },
    });
    registry.controlUiDescriptors = [
      {
        pluginId: "fuzzplugin",
        pluginName: "Fuzz Plugin",
        descriptor: unreadableDescriptor,
        source: "test",
      } as never,
      Object.create(null, {
        pluginId: { enumerable: true, value: "mockplugin" },
        pluginName: {
          enumerable: true,
          get() {
            throw new Error("mockplugin name is unreadable");
          },
        },
        descriptor: { enumerable: true, value: healthyDescriptor },
        source: { enumerable: true, value: "test" },
      }) as never,
    ];
    setActivePluginRegistry(registry);
    const respond = vi.fn();

    await pluginHostHookHandlers["plugins.uiDescriptors"]({
      params: {},
      respond: respond as never,
    } as never);

    const [ok, result, error] = respondCall(respond);
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(result).toEqual({
      ok: true,
      descriptors: [
        {
          id: "mockplugin-card",
          pluginId: "mockplugin",
          surface: "session",
          label: "Mock Card",
          requiredScopes: ["operator.read"],
        },
      ],
    });
  });
});
