import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderAgentHarnessContract } from "../plugins/provider-runtime.js";
import type { ProviderAgentHarnessContract } from "../plugins/types.js";
import { resolveAgentCustomHarnessId, resolveSessionAgentIds } from "./agent-scope.js";
import type { AnyAgentTool } from "./tools/common.js";

export function collectPresentOpenClawTools(
  candidates: readonly (AnyAgentTool | null | undefined)[],
): AnyAgentTool[] {
  return candidates.filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
}

export function isUpdatePlanToolEnabledForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
  resolveHarnessContract?: typeof resolveProviderAgentHarnessContract;
}): boolean {
  const configured = params.config?.tools?.experimental?.planTool;
  if (configured !== undefined) {
    return configured;
  }
  return resolveOpenClawToolsAgentHarnessContract(params)?.planToolDefault === true;
}

export function resolveOpenClawToolsAgentHarnessContract(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
  resolveHarnessContract?: typeof resolveProviderAgentHarnessContract;
}): ProviderAgentHarnessContract | undefined {
  const provider = params.modelProvider?.trim();
  const modelId = params.modelId?.trim();
  if (!provider || !modelId) {
    return undefined;
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.agentSessionKey,
    config: params.config,
    agentId: params.agentId ?? undefined,
  });
  const customHarnessId = resolveAgentCustomHarnessId(params.config, sessionAgentId);
  if (!customHarnessId) {
    return undefined;
  }
  const resolveHarnessContract =
    params.resolveHarnessContract ?? resolveProviderAgentHarnessContract;
  return resolveHarnessContract({
    provider,
    config: params.config,
    context: {
      config: params.config,
      provider,
      modelId,
      customHarnessId,
      agentId: sessionAgentId,
      sessionKey: params.agentSessionKey,
    },
  });
}
