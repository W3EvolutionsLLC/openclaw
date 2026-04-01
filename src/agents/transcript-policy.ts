import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderReplayPolicyWithPlugin } from "../plugins/provider-runtime.js";
import type { ProviderRuntimeModel } from "../plugins/types.js";
import { normalizeProviderId } from "./model-selection.js";
import { isGoogleModelApi } from "./pi-embedded-helpers/google.js";
import type { ToolCallIdMode } from "./tool-call-id.js";

export type TranscriptSanitizeMode = "full" | "images-only";

export type TranscriptPolicy = {
  sanitizeMode: TranscriptSanitizeMode;
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: ToolCallIdMode;
  repairToolUseResultPairing: boolean;
  preserveSignatures: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  sanitizeThinkingSignatures: boolean;
  dropThinkingBlocks: boolean;
  applyGoogleTurnOrdering: boolean;
  validateGeminiTurns: boolean;
  validateAnthropicTurns: boolean;
  allowSyntheticToolResults: boolean;
};

function isAnthropicApi(modelApi?: string | null): boolean {
  return modelApi === "anthropic-messages" || modelApi === "bedrock-converse-stream";
}

function shouldDropAnthropicThinkingBlocks(modelId?: string | null): boolean {
  return (modelId ?? "").toLowerCase().includes("claude");
}

export function resolveTranscriptPolicy(params: {
  modelApi?: string | null;
  provider?: string | null;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  model?: ProviderRuntimeModel;
}): TranscriptPolicy {
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = params.modelId ?? "";
  const isGoogle = isGoogleModelApi(params.modelApi);
  const isAnthropic = isAnthropicApi(params.modelApi);
  const isStrictOpenAiCompatible = params.modelApi === "openai-completions";
  const requiresOpenAiCompatibleToolIdSanitization =
    params.modelApi === "openai-completions" ||
    params.modelApi === "openai-responses" ||
    params.modelApi === "openai-codex-responses" ||
    params.modelApi === "azure-openai-responses";
  // All providers need orphaned tool_result repair after history truncation.
  // OpenAI rejects function_call_output items whose call_id has no matching
  // function_call in the conversation, so the repair must run universally.
  const repairToolUseResultPairing = true;

  const basePolicy: TranscriptPolicy = {
    sanitizeMode: isGoogle || isAnthropic ? "full" : "images-only",
    sanitizeToolCallIds: isGoogle || isAnthropic || requiresOpenAiCompatibleToolIdSanitization,
    toolCallIdMode: (isGoogle || isAnthropic || requiresOpenAiCompatibleToolIdSanitization
      ? "strict"
      : undefined) as ToolCallIdMode | undefined,
    repairToolUseResultPairing,
    preserveSignatures: isAnthropic,
    sanitizeThoughtSignatures: isGoogle
      ? { allowBase64Only: true, includeCamelCase: true }
      : undefined,
    sanitizeThinkingSignatures: false,
    dropThinkingBlocks: isAnthropic && shouldDropAnthropicThinkingBlocks(modelId),
    applyGoogleTurnOrdering: isGoogle || isStrictOpenAiCompatible,
    validateGeminiTurns: isGoogle || isStrictOpenAiCompatible,
    validateAnthropicTurns: isAnthropic || isStrictOpenAiCompatible,
    allowSyntheticToolResults: isGoogle || isAnthropic,
  };

  const pluginPolicy = provider
    ? resolveProviderReplayPolicyWithPlugin({
        provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        context: {
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          provider,
          modelId,
          modelApi: params.modelApi,
          model: params.model,
        },
      })
    : undefined;
  if (!pluginPolicy) {
    return basePolicy;
  }

  return {
    ...basePolicy,
    ...(pluginPolicy.sanitizeMode != null ? { sanitizeMode: pluginPolicy.sanitizeMode } : {}),
    ...(typeof pluginPolicy.sanitizeToolCallIds === "boolean"
      ? { sanitizeToolCallIds: pluginPolicy.sanitizeToolCallIds }
      : {}),
    ...(pluginPolicy.toolCallIdMode ? { toolCallIdMode: pluginPolicy.toolCallIdMode } : {}),
    ...(typeof pluginPolicy.repairToolUseResultPairing === "boolean"
      ? { repairToolUseResultPairing: pluginPolicy.repairToolUseResultPairing }
      : {}),
    ...(typeof pluginPolicy.preserveSignatures === "boolean"
      ? { preserveSignatures: pluginPolicy.preserveSignatures }
      : {}),
    ...(pluginPolicy.sanitizeThoughtSignatures
      ? { sanitizeThoughtSignatures: pluginPolicy.sanitizeThoughtSignatures }
      : {}),
    ...(typeof pluginPolicy.dropThinkingBlocks === "boolean"
      ? { dropThinkingBlocks: pluginPolicy.dropThinkingBlocks }
      : {}),
    ...(typeof pluginPolicy.applyAssistantFirstOrderingFix === "boolean"
      ? { applyGoogleTurnOrdering: pluginPolicy.applyAssistantFirstOrderingFix }
      : {}),
    ...(typeof pluginPolicy.validateGeminiTurns === "boolean"
      ? { validateGeminiTurns: pluginPolicy.validateGeminiTurns }
      : {}),
    ...(typeof pluginPolicy.validateAnthropicTurns === "boolean"
      ? { validateAnthropicTurns: pluginPolicy.validateAnthropicTurns }
      : {}),
    ...(typeof pluginPolicy.allowSyntheticToolResults === "boolean"
      ? { allowSyntheticToolResults: pluginPolicy.allowSyntheticToolResults }
      : {}),
  };
}
