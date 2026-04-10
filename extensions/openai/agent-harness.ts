import type {
  ProviderAgentHarnessContext,
  ProviderAgentHarnessContract,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const OPENAI_PROVIDER_IDS = new Set(["openai", "openai-codex"]);
const OPENAI_GPT5_MODEL_PREFIX = "gpt-5";

export const OPENAI_CODEX_CUSTOM_HARNESS_ID = "codex";

export const OPENAI_CODEX_AGENT_HARNESS_CONTRACT = {
  id: OPENAI_CODEX_CUSTOM_HARNESS_ID,
  planToolDefault: true,
  planningOnlyRetryLimit: 2,
  planningOnlyBlockedText:
    "Agent stopped after repeated plan-only turns without taking a concrete action. No concrete tool action or external side effect advanced the task.",
  ackExecutionFastPath: true,
} satisfies ProviderAgentHarnessContract;

export function shouldApplyOpenAICodexCustomHarness(params: {
  provider?: string;
  modelId?: string;
  customHarnessId?: string;
}): boolean {
  if (params.customHarnessId !== OPENAI_CODEX_CUSTOM_HARNESS_ID) {
    return false;
  }
  if (!OPENAI_PROVIDER_IDS.has(normalizeLowercaseStringOrEmpty(params.provider))) {
    return false;
  }
  return normalizeLowercaseStringOrEmpty(params.modelId).startsWith(OPENAI_GPT5_MODEL_PREFIX);
}

export function resolveOpenAIAgentHarnessContract(
  ctx: ProviderAgentHarnessContext,
): ProviderAgentHarnessContract | undefined {
  return shouldApplyOpenAICodexCustomHarness({
    provider: ctx.provider,
    modelId: ctx.modelId,
    customHarnessId: ctx.customHarnessId,
  })
    ? OPENAI_CODEX_AGENT_HARNESS_CONTRACT
    : undefined;
}
