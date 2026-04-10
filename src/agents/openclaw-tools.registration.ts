import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentExecutionContract, resolveSessionAgentId } from "./agent-scope.js";
import type { AnyAgentTool } from "./tools/common.js";

export function collectPresentOpenClawTools(
  candidates: readonly (AnyAgentTool | null | undefined)[],
): AnyAgentTool[] {
  return candidates.filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
}

export function isUpdatePlanToolEnabledForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): boolean {
  const configured = params.config?.tools?.experimental?.planTool;
  if (configured !== undefined) {
    return configured;
  }
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: params.agentSessionKey,
    config: params.config,
  });
  return resolveAgentExecutionContract(params.config, sessionAgentId) === "strict-agentic";
}
