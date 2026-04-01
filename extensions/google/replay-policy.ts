import type {
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
  ProviderReasoningOutputMode,
  ProviderReplayPolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import { cleanSchemaForGemini } from "openclaw/plugin-sdk/provider-tools";

/**
 * Returns the provider-owned replay policy for Google Gemini transports.
 */
export function buildGoogleReplayPolicy(): ProviderReplayPolicy {
  return {
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
  };
}

/**
 * Returns the provider-owned reasoning output mode for Google Gemini transports.
 */
export function resolveGoogleReasoningOutputMode(): ProviderReasoningOutputMode {
  return "tagged";
}

/**
 * Normalizes Gemini CLI tool schemas to the restricted JSON Schema subset
 * accepted by the Cloud Code Assist transport.
 */
export function normalizeGoogleGeminiCliToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return ctx.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: cleanSchemaForGemini(tool.parameters as Record<string, unknown>),
    };
  });
}
