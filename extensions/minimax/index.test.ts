import { describe, expect, it } from "vitest";
import {
  registerProviderPlugins,
  requireRegisteredProvider,
} from "../../src/test-utils/plugin-registration.js";
import minimaxPlugin from "./index.js";

describe("minimax provider hooks", () => {
  it("owns tagged reasoning mode for MiniMax transports", () => {
    const providers = registerProviderPlugins(minimaxPlugin);
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    expect(apiProvider.hookAliases).toContain("minimax-cn");
    expect(
      apiProvider.resolveReasoningOutputMode?.({
        provider: "minimax",
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toBe("tagged");

    expect(portalProvider.hookAliases).toContain("minimax-portal-cn");
    expect(
      portalProvider.resolveReasoningOutputMode?.({
        provider: "minimax-portal",
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toBe("tagged");
  });
});
