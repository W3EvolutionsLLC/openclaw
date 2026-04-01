import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCapabilities } from "./provider-capabilities.js";

const resolveProviderCapabilitiesWithPluginMock = vi.fn(
  (params: { provider: string; workspaceDir?: string }) => {
    switch (params.provider) {
      case "anthropic-proxy":
        return {
          anthropicToolSchemaMode: "openai-functions",
          anthropicToolChoiceMode: "openai-string-modes",
        } satisfies Partial<ProviderCapabilities>;
      case "workspace-anthropic-proxy":
        return params.workspaceDir === "/tmp/workspace-capabilities"
          ? ({
              anthropicToolSchemaMode: "openai-functions",
              anthropicToolChoiceMode: "openai-string-modes",
            } satisfies Partial<ProviderCapabilities>)
          : undefined;
      default:
        return undefined;
    }
  },
);

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderCapabilitiesWithPlugin: (params: { provider: string; workspaceDir?: string }) =>
    resolveProviderCapabilitiesWithPluginMock(params),
}));

let requiresOpenAiCompatibleAnthropicToolPayload: typeof import("./provider-capabilities.js").requiresOpenAiCompatibleAnthropicToolPayload;
let usesOpenAiFunctionAnthropicToolSchema: typeof import("./provider-capabilities.js").usesOpenAiFunctionAnthropicToolSchema;
let usesOpenAiStringModeAnthropicToolChoice: typeof import("./provider-capabilities.js").usesOpenAiStringModeAnthropicToolChoice;

describe("provider-capabilities", () => {
  beforeAll(async () => {
    ({
      requiresOpenAiCompatibleAnthropicToolPayload,
      usesOpenAiFunctionAnthropicToolSchema,
      usesOpenAiStringModeAnthropicToolChoice,
    } = await import("./provider-capabilities.js"));
  });

  beforeEach(() => {
    resolveProviderCapabilitiesWithPluginMock.mockClear();
  });

  it("defaults to native anthropic tool payload behavior", () => {
    expect(requiresOpenAiCompatibleAnthropicToolPayload("anthropic")).toBe(false);
    expect(usesOpenAiFunctionAnthropicToolSchema("anthropic")).toBe(false);
    expect(usesOpenAiStringModeAnthropicToolChoice("anthropic")).toBe(false);
  });

  it("uses plugin-owned anthropic tool payload overrides", () => {
    expect(requiresOpenAiCompatibleAnthropicToolPayload("anthropic-proxy")).toBe(true);
    expect(usesOpenAiFunctionAnthropicToolSchema("anthropic-proxy")).toBe(true);
    expect(usesOpenAiStringModeAnthropicToolChoice("anthropic-proxy")).toBe(true);
  });

  it("passes lookup options through to the provider runtime", () => {
    expect(
      requiresOpenAiCompatibleAnthropicToolPayload("workspace-anthropic-proxy", {
        workspaceDir: "/tmp/workspace-capabilities",
      }),
    ).toBe(true);

    expect(resolveProviderCapabilitiesWithPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "workspace-anthropic-proxy",
        workspaceDir: "/tmp/workspace-capabilities",
      }),
    );
  });
});
