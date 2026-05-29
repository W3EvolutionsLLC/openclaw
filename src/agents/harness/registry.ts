import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentHarness, AgentHarnessResetParams, RegisteredAgentHarness } from "./types.js";

const AGENT_HARNESS_REGISTRY_STATE = Symbol.for("openclaw.agentHarnessRegistryState");
const log = createSubsystemLogger("agents/harness");
const REGISTERED_HARNESS_RESERVED_KEYS = new Set<PropertyKey>([
  "id",
  "label",
  "pluginId",
  "contextEngineHostCapabilities",
  "deliveryDefaults",
  "supports",
  "runAttempt",
  "runSideQuestion",
  "classify",
  "compact",
  "reset",
  "dispose",
]);

type AgentHarnessRegistryState = {
  harnesses: Map<string, RegisteredAgentHarness>;
};

function getAgentHarnessRegistryState(): AgentHarnessRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [AGENT_HARNESS_REGISTRY_STATE]?: AgentHarnessRegistryState;
  };
  globalState[AGENT_HARNESS_REGISTRY_STATE] ??= {
    harnesses: new Map<string, RegisteredAgentHarness>(),
  };
  return globalState[AGENT_HARNESS_REGISTRY_STATE];
}

function bindRegisteredAgentHarness(
  harness: AgentHarness,
  params: { id: string; pluginId?: string },
): AgentHarness {
  const registeredHarness = {} as AgentHarness;
  for (const key of Reflect.ownKeys(harness)) {
    if (REGISTERED_HARNESS_RESERVED_KEYS.has(key)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(harness, key);
    if (descriptor && "value" in descriptor) {
      Object.defineProperty(registeredHarness, key, descriptor);
    }
  }
  Object.assign(registeredHarness, {
    id: params.id,
    label: harness.label,
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    ...(harness.contextEngineHostCapabilities
      ? { contextEngineHostCapabilities: harness.contextEngineHostCapabilities }
      : {}),
    ...(harness.deliveryDefaults ? { deliveryDefaults: harness.deliveryDefaults } : {}),
  });
  const prototype = Object.getPrototypeOf(harness);
  const methodReceiver =
    prototype === Object.prototype || prototype === null ? registeredHarness : harness;
  Object.assign(registeredHarness, {
    supports: harness.supports.bind(methodReceiver),
    runAttempt: harness.runAttempt.bind(methodReceiver),
    ...(harness.runSideQuestion
      ? { runSideQuestion: harness.runSideQuestion.bind(methodReceiver) }
      : {}),
    ...(harness.classify ? { classify: harness.classify.bind(methodReceiver) } : {}),
    ...(harness.compact ? { compact: harness.compact.bind(methodReceiver) } : {}),
    ...(harness.reset ? { reset: harness.reset.bind(methodReceiver) } : {}),
    ...(harness.dispose ? { dispose: harness.dispose.bind(methodReceiver) } : {}),
  });
  return registeredHarness;
}

export function registerAgentHarness(
  harness: AgentHarness,
  options?: { ownerPluginId?: string },
): void {
  const id = harness.id.trim();
  const pluginId = harness.pluginId ?? options?.ownerPluginId;
  let registeredHarness = harness;
  try {
    Object.defineProperty(harness, "id", {
      value: id,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    if (pluginId) {
      Object.defineProperty(harness, "pluginId", {
        value: pluginId,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  } catch {
    registeredHarness = bindRegisteredAgentHarness(harness, { id, pluginId });
  }
  getAgentHarnessRegistryState().harnesses.set(id, {
    harness: registeredHarness,
    ownerPluginId: options?.ownerPluginId,
  });
}

export function getAgentHarness(id: string): AgentHarness | undefined {
  return getRegisteredAgentHarness(id)?.harness;
}

export function getRegisteredAgentHarness(id: string): RegisteredAgentHarness | undefined {
  return getAgentHarnessRegistryState().harnesses.get(id.trim());
}

export function listAgentHarnessIds(): string[] {
  return [...getAgentHarnessRegistryState().harnesses.keys()];
}

export function listRegisteredAgentHarnesses(): RegisteredAgentHarness[] {
  return Array.from(getAgentHarnessRegistryState().harnesses.values());
}

export function clearAgentHarnesses(): void {
  getAgentHarnessRegistryState().harnesses.clear();
}

export function restoreRegisteredAgentHarnesses(entries: RegisteredAgentHarness[]): void {
  const map = getAgentHarnessRegistryState().harnesses;
  map.clear();
  for (const entry of entries) {
    map.set(entry.harness.id, entry);
  }
}

export async function resetRegisteredAgentHarnessSessions(
  params: AgentHarnessResetParams,
): Promise<void> {
  await Promise.all(
    listRegisteredAgentHarnesses().map(async (entry) => {
      if (!entry.harness.reset) {
        return;
      }
      try {
        await entry.harness.reset(params);
      } catch (error) {
        log.warn(`${entry.harness.label} session reset hook failed`, {
          harnessId: entry.harness.id,
          error,
        });
      }
    }),
  );
}

export async function disposeRegisteredAgentHarnesses(): Promise<void> {
  await Promise.all(
    listRegisteredAgentHarnesses().map(async (entry) => {
      if (!entry.harness.dispose) {
        return;
      }
      try {
        await entry.harness.dispose();
      } catch (error) {
        log.warn(`${entry.harness.label} dispose hook failed`, {
          harnessId: entry.harness.id,
          error,
        });
      }
    }),
  );
}
