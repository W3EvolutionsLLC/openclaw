import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { SESSION_BULK_MESSAGE_TASK_KIND } from "../tasks/session-bulk-message-task-contract.js";
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
  if (params.task.taskKind === SESSION_BULK_MESSAGE_TASK_KIND) {
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
