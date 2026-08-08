import {
  createAgentExecutionAttribution,
  type AgentExecutionAttribution,
  type AgentExecutionIdentityAdmission,
} from "../../agents/agent-execution-attribution.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { clientHasAdminScope } from "./agent-handler-helpers.js";
import type { GatewayClient } from "./shared-types.js";

/** Creates admission-owned attribution and stamps only handshake-attested local operators. */
export function createGatewayAgentExecutionAttribution(params: {
  runId: string;
  lifecycleGeneration: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  executionIdentityAdmission?: AgentExecutionIdentityAdmission;
  client?: GatewayClient | null;
  inputProvenance?: InputProvenance;
  hasRestoredCronContinuation: boolean;
}): AgentExecutionAttribution {
  const internal = params.client?.internal;
  const localOperatorAuthority =
    clientHasAdminScope(params.client ?? null) &&
    internal?.isLocalClient === true &&
    params.inputProvenance === undefined &&
    !params.hasRestoredCronContinuation &&
    internal.syntheticClient !== true &&
    internal.cronRunContinuation !== true &&
    internal.pluginRuntimeOwnerId === undefined &&
    internal.delegatedToolPolicyHandoffId === undefined;
  return createAgentExecutionAttribution({
    runId: params.runId,
    lifecycleGeneration: params.lifecycleGeneration,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    ...(params.executionIdentityAdmission
      ? { executionIdentityAdmission: params.executionIdentityAdmission }
      : {}),
    ...(localOperatorAuthority ? { localOperatorAuthority: true } : {}),
  });
}
