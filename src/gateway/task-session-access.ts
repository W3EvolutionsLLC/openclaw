import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isSessionBulkMessageTask } from "../tasks/session-bulk-message-task-contract.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { GatewayClient } from "./server-methods/types.js";
import { sessionBulkMessageOwnerKey } from "./session-bulk-message-operation-access.js";
import { canAccessIncognitoSession } from "./session-sharing.js";

export function resolveTaskRequesterSessionTarget(
  task: Pick<TaskRecord, "ownerKey" | "requesterAgentId" | "requesterSessionKey">,
): { sessionKey: string; agentId?: string } | undefined {
  const sessionKey = normalizeOptionalString(task.requesterSessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const agentId =
    normalizeOptionalString(task.requesterAgentId) ??
    parseAgentSessionKey(sessionKey)?.agentId ??
    parseAgentSessionKey(task.ownerKey)?.agentId;
  return { sessionKey, ...(agentId ? { agentId } : {}) };
}

export function canAccessTaskRequesterSession(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  task: Pick<TaskRecord, "ownerKey" | "requesterAgentId" | "requesterSessionKey" | "taskKind">;
}): boolean {
  if (isSessionBulkMessageTask(params.task)) {
    return params.task.ownerKey === sessionBulkMessageOwnerKey(params.client);
  }
  const target = resolveTaskRequesterSessionTarget(params.task);
  return (
    !target ||
    canAccessIncognitoSession({
      cfg: params.cfg,
      client: params.client,
      ...target,
    })
  );
}

/** Profile-private tasks use their typed owner RPC instead of the global task event stream. */
export function canBroadcastTaskEvent(task: Pick<TaskRecord, "taskKind">): boolean {
  return !isSessionBulkMessageTask(task);
}
