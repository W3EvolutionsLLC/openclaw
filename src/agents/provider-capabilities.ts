import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderCapabilitiesWithPlugin as resolveProviderCapabilitiesWithPluginRuntime } from "../plugins/provider-runtime.js";
import { normalizeProviderId } from "./provider-id.js";

export type ProviderCapabilities = {
  anthropicToolSchemaMode: "native" | "openai-functions";
  anthropicToolChoiceMode: "native" | "openai-string-modes";
  openAiPayloadNormalizationMode: "default" | "moonshot-thinking";
  providerFamily: "default" | "openai" | "anthropic";
  preserveAnthropicThinkingSignatures: boolean;
  openAiCompatTurnValidation: boolean;
  geminiThoughtSignatureSanitization: boolean;
  transcriptToolCallIdMode: "default" | "strict9";
  transcriptToolCallIdModelHints: string[];
  geminiThoughtSignatureModelHints: string[];
  dropThinkingBlockModelHints: string[];
};

export type ProviderCapabilityLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

type AnthropicToolPayloadCapabilities = Pick<
  ProviderCapabilities,
  "anthropicToolSchemaMode" | "anthropicToolChoiceMode"
>;

const DEFAULT_ANTHROPIC_TOOL_PAYLOAD_CAPABILITIES: AnthropicToolPayloadCapabilities = {
  anthropicToolSchemaMode: "native",
  anthropicToolChoiceMode: "native",
};

const defaultResolveProviderCapabilitiesWithPlugin = resolveProviderCapabilitiesWithPluginRuntime;
const providerCapabilityDeps = {
  resolveProviderCapabilitiesWithPlugin: defaultResolveProviderCapabilitiesWithPlugin,
};

export const __testing = {
  setResolveProviderCapabilitiesWithPluginForTest(
    resolveProviderCapabilitiesWithPlugin?: typeof defaultResolveProviderCapabilitiesWithPlugin,
  ): void {
    providerCapabilityDeps.resolveProviderCapabilitiesWithPlugin =
      resolveProviderCapabilitiesWithPlugin ?? defaultResolveProviderCapabilitiesWithPlugin;
  },
  resetDepsForTests(): void {
    providerCapabilityDeps.resolveProviderCapabilitiesWithPlugin =
      defaultResolveProviderCapabilitiesWithPlugin;
  },
};

function resolveAnthropicToolPayloadCapabilities(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): AnthropicToolPayloadCapabilities {
  const normalized = normalizeProviderId(provider ?? "");
  if (!normalized) {
    return DEFAULT_ANTHROPIC_TOOL_PAYLOAD_CAPABILITIES;
  }

  const pluginCapabilities =
    providerCapabilityDeps.resolveProviderCapabilitiesWithPlugin({
      provider: normalized,
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      env: options?.env,
    }) ?? undefined;

  return {
    ...DEFAULT_ANTHROPIC_TOOL_PAYLOAD_CAPABILITIES,
    ...(pluginCapabilities
      ? {
          anthropicToolSchemaMode:
            pluginCapabilities.anthropicToolSchemaMode ??
            DEFAULT_ANTHROPIC_TOOL_PAYLOAD_CAPABILITIES.anthropicToolSchemaMode,
          anthropicToolChoiceMode:
            pluginCapabilities.anthropicToolChoiceMode ??
            DEFAULT_ANTHROPIC_TOOL_PAYLOAD_CAPABILITIES.anthropicToolChoiceMode,
        }
      : {}),
  };
}

export function requiresOpenAiCompatibleAnthropicToolPayload(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  const capabilities = resolveAnthropicToolPayloadCapabilities(provider, options);
  return (
    capabilities.anthropicToolSchemaMode !== "native" ||
    capabilities.anthropicToolChoiceMode !== "native"
  );
}

export function usesOpenAiFunctionAnthropicToolSchema(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  return (
    resolveAnthropicToolPayloadCapabilities(provider, options).anthropicToolSchemaMode ===
    "openai-functions"
  );
}

export function usesOpenAiStringModeAnthropicToolChoice(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  return (
    resolveAnthropicToolPayloadCapabilities(provider, options).anthropicToolChoiceMode ===
    "openai-string-modes"
  );
}
