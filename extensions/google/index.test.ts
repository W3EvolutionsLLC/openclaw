import { describe, expect, it } from "vitest";
import {
  registerProviderPlugins,
  requireRegisteredProvider,
} from "../../src/test-utils/plugin-registration.js";
import googlePlugin from "./index.js";

describe("google provider plugin hooks", () => {
  it("owns replay policy and reasoning mode for the direct Gemini provider", () => {
    const providers = registerProviderPlugins(googlePlugin);
    const provider = requireRegisteredProvider(providers, "google");

    expect(
      provider.buildReplayPolicy?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
      repairToolUseResultPairing: true,
      applyAssistantFirstOrderingFix: true,
      allowSyntheticToolResults: true,
    });

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toBe("tagged");
  });

  it("owns Gemini CLI tool schema normalization", () => {
    const providers = registerProviderPlugins(googlePlugin);
    const provider = requireRegisteredProvider(providers, "google-gemini-cli");

    const [tool] =
      provider.normalizeToolSchemas?.({
        provider: "google-gemini-cli",
        tools: [
          {
            name: "write_file",
            description: "Write a file",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", pattern: "^src/" },
              },
            },
          },
        ],
      } as never) ?? [];

    expect(tool).toMatchObject({
      name: "write_file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    });
    expect(tool?.parameters).not.toHaveProperty("additionalProperties");
    expect(
      (tool?.parameters as { properties?: { path?: Record<string, unknown> } })?.properties?.path,
    ).not.toHaveProperty("pattern");
  });
});
