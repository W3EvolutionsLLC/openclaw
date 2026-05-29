import { describe, expect, it } from "vitest";
import { normalizeAgentToolResultMiddlewareRuntimes } from "./agent-tool-result-middleware.js";

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
