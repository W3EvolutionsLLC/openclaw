// Agent event subscription registration tests cover plugin-owned callback snapshotting.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchPluginAgentEventSubscriptions } from "../host-hook-runtime.js";
import type { PluginAgentEventSubscriptionRegistration } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";

describe("plugin agent event subscription registration", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("snapshots subscription callbacks before event dispatch", () => {
    let handleReads = 0;
    let streamsReads = 0;
    const handledStreams: string[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "volatile-agent-events",
        name: "Volatile Agent Events",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "events",
          description: "Event sink",
          get streams() {
            streamsReads += 1;
            if (streamsReads > 1) {
              throw new Error("streams getter re-read");
            }
            return ["tool"];
          },
          get handle() {
            handleReads += 1;
            if (handleReads > 1) {
              throw new Error("handle getter re-read");
            }
            return (event) => {
              handledStreams.push(event.stream);
            };
          },
        } as PluginAgentEventSubscriptionRegistration);
      },
    });
    setActivePluginRegistry(registry.registry);

    expect(registry.registry.agentEventSubscriptions?.[0]?.subscription.description).toBe(
      "Event sink",
    );
    expect(handleReads).toBe(1);
    expect(streamsReads).toBe(1);

    dispatchPluginAgentEventSubscriptions({
      registry: registry.registry,
      event: {
        runId: "run-1",
        stream: "tool",
        data: { name: "approval_fixture_tool" },
      },
    });

    expect(handledStreams).toEqual(["tool"]);
    expect(handleReads).toBe(1);
    expect(streamsReads).toBe(1);
  });
});
