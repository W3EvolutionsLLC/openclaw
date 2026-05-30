import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResultMiddleware } from "./agent-tool-result-middleware-types.js";
import {
  listAgentToolResultMiddlewares,
  normalizeAgentToolResultMiddlewareRuntimes,
} from "./agent-tool-result-middleware.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginAgentToolResultMiddlewareRegistration } from "./registry-types.js";
import { setActivePluginRegistry } from "./runtime.js";

describe("normalizeAgentToolResultMiddlewareRuntimes", () => {
  it("defaults omitted runtimes to every supported runtime", () => {
    expect(normalizeAgentToolResultMiddlewareRuntimes()).toEqual(["openclaw", "codex"]);
  });

  it("preserves an explicit empty runtime list", () => {
    expect(normalizeAgentToolResultMiddlewareRuntimes({ runtimes: [] })).toEqual([]);
  });

  it("normalizes legacy harness names", () => {
    expect(
      normalizeAgentToolResultMiddlewareRuntimes({ harnesses: ["codex-app-server", "openclaw"] }),
    ).toEqual(["codex", "openclaw"]);
  });

  it("falls back to legacy harnesses when runtimes is undefined", () => {
    expect(
      normalizeAgentToolResultMiddlewareRuntimes({
        runtimes: undefined,
        harnesses: ["codex-app-server"],
      }),
    ).toEqual(["codex"]);
  });

  it("fails closed on unreadable runtime option containers", () => {
    const unreadableRuntimes: Record<string, unknown> = {};
    Object.defineProperty(unreadableRuntimes, "runtimes", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin middleware runtimes are unreadable");
      },
    });
    const revokedRuntimes = Proxy.revocable(["codex"], {});
    revokedRuntimes.revoke();

    expect(normalizeAgentToolResultMiddlewareRuntimes(unreadableRuntimes as never)).toEqual([]);
    expect(
      normalizeAgentToolResultMiddlewareRuntimes({
        runtimes: revokedRuntimes.proxy as never,
      }),
    ).toEqual([]);
  });

  it("ignores malformed runtime entries before normalizing", () => {
    expect(
      normalizeAgentToolResultMiddlewareRuntimes({
        runtimes: [{} as never, " codex ", 1 as never, "openclaw"],
      }),
    ).toEqual(["codex", "openclaw"]);
  });
});

describe("listAgentToolResultMiddlewares", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("skips unreadable synthetic middleware entries while preserving healthy handlers", () => {
    const registry = createEmptyPluginRegistry();
    const healthyHandler: AgentToolResultMiddleware = vi.fn();
    const unreadableEntry = {
      pluginId: "fuzzplugin",
      pluginName: "Fuzz Plugin",
      rawHandler: vi.fn(),
      source: "synthetic",
    } as PluginAgentToolResultMiddlewareRegistration;
    Object.defineProperties(unreadableEntry, {
      runtimes: {
        enumerable: true,
        get() {
          throw new Error("fuzzplugin middleware runtime read failed");
        },
      },
      handler: {
        enumerable: true,
        get() {
          throw new Error("fuzzplugin middleware handler read failed");
        },
      },
    });
    registry.agentToolResultMiddlewares.push(unreadableEntry, {
      pluginId: "mockplugin",
      pluginName: "Mock Plugin",
      rawHandler: healthyHandler,
      handler: healthyHandler,
      runtimes: ["codex"],
      source: "synthetic",
    });

    setActivePluginRegistry(registry);

    expect(listAgentToolResultMiddlewares("codex")).toEqual([healthyHandler]);
    expect(listAgentToolResultMiddlewares("openclaw")).toEqual([]);
  });
});
