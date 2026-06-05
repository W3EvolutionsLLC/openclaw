// Node host command registration tests cover plugin-owned command snapshotting.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { listDangerousPluginNodeCommands } from "../../gateway/node-command-policy.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginNodeHostCommand } from "../types.js";

describe("plugin node host command registration", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("snapshots command fields before dangerous command projection", async () => {
    let commandReads = 0;
    let capReads = 0;
    let dangerousReads = 0;
    let handleReads = 0;
    const handler: OpenClawPluginNodeHostCommand["handle"] = async (paramsJSON) =>
      paramsJSON ?? "{}";
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "volatile-node-host-command",
        name: "Volatile Node Host Command",
      }),
      register(api) {
        api.registerNodeHostCommand({
          get command() {
            commandReads += 1;
            if (commandReads > 1) {
              throw new Error("node host command getter re-read");
            }
            return " volatile.host ";
          },
          get cap() {
            capReads += 1;
            if (capReads > 1) {
              throw new Error("node host command cap getter re-read");
            }
            return " screen ";
          },
          get dangerous() {
            dangerousReads += 1;
            if (dangerousReads > 1) {
              throw new Error("node host command dangerous getter re-read");
            }
            return true;
          },
          get handle() {
            handleReads += 1;
            if (handleReads > 1) {
              throw new Error("node host command handle getter re-read");
            }
            return handler;
          },
        } as OpenClawPluginNodeHostCommand);
      },
    });
    setActivePluginRegistry(registry.registry);

    const command = registry.registry.nodeHostCommands?.[0]?.command;
    expect(command).toMatchObject({
      command: "volatile.host",
      cap: "screen",
      dangerous: true,
    });
    expect(listDangerousPluginNodeCommands()).toEqual(["volatile.host"]);
    await expect(command?.handle('{"ok":true}')).resolves.toBe('{"ok":true}');

    expect(commandReads).toBe(1);
    expect(capReads).toBe(1);
    expect(dangerousReads).toBe(1);
    expect(handleReads).toBe(1);
  });
});
