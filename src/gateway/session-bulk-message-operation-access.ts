import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import {
  ErrorShapeSchema,
  type SessionsOperationTargetOutcome,
} from "../../packages/gateway-protocol/src/index.js";
import { getTaskById, listTaskRecords } from "../tasks/runtime-internal.js";
import { SESSION_BULK_MESSAGE_TASK_KIND } from "../tasks/session-bulk-message-task-contract.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";

const BULK_MESSAGE_DETAIL_VERSION = 1;
const SOLO_OPERATION_OWNER_KEY = "sessions.operations:solo";

export type StoredBulkMessageDetail = {
  version: 1;
  kind: "bulk-message";
  requestId: string;
  message: string;
  targets: SessionsOperationTargetOutcome[];
  retryOf?: string;
};

export function sessionBulkMessageOwnerKey(client: GatewayClient | null): string {
  const creator = gatewayClientSessionCreator(client);
  return creator ? `sessions.operations:profile:${creator.id}` : SOLO_OPERATION_OWNER_KEY;
}

export function parseSessionBulkMessageDetail(task: TaskRecord): StoredBulkMessageDetail | null {
  const detail = task.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return null;
  }
  if (
    detail.version !== BULK_MESSAGE_DETAIL_VERSION ||
    detail.kind !== "bulk-message" ||
    typeof detail.requestId !== "string" ||
    typeof detail.message !== "string" ||
    !Array.isArray(detail.targets)
  ) {
    return null;
  }
  const targets: SessionsOperationTargetOutcome[] = [];
  for (const candidate of detail.targets) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const key = normalizeOptionalString(candidate.key);
    const expectedSessionId = normalizeOptionalString(candidate.expectedSessionId);
    const status = candidate.status;
    if (
      !key ||
      !expectedSessionId ||
      (status !== "pending" && status !== "accepted" && status !== "failed")
    ) {
      return null;
    }
    const agentId = normalizeOptionalString(candidate.agentId);
    const runId = normalizeOptionalString(candidate.runId);
    const storedError = candidate.error;
    const error = Value.Check(ErrorShapeSchema, storedError)
      ? structuredClone(storedError)
      : undefined;
    targets.push({
      key,
      expectedSessionId,
      status,
      ...(agentId ? { agentId } : {}),
      ...(runId ? { runId } : {}),
      ...(error ? { error } : {}),
    });
  }
  const retryOf = normalizeOptionalString(detail.retryOf);
  return {
    version: BULK_MESSAGE_DETAIL_VERSION,
    kind: "bulk-message",
    requestId: detail.requestId,
    message: detail.message,
    targets,
    ...(retryOf ? { retryOf } : {}),
  };
}

export function sessionBulkMessageTask(params: {
  taskId: string;
  ownerKey: string;
}): { task: TaskRecord; detail: StoredBulkMessageDetail } | null {
  const task = getTaskById(params.taskId);
  if (
    !task ||
    task.taskKind !== SESSION_BULK_MESSAGE_TASK_KIND ||
    task.ownerKey !== params.ownerKey
  ) {
    return null;
  }
  const detail = parseSessionBulkMessageDetail(task);
  return detail ? { task, detail } : null;
}

export function sessionBulkMessageTasks(ownerKey: string) {
  return listTaskRecords().filter(
    (task) => task.taskKind === SESSION_BULK_MESSAGE_TASK_KIND && task.ownerKey === ownerKey,
  );
}

export function findSessionBulkMessageTask(params: { ownerKey: string; requestId: string }) {
  return sessionBulkMessageTasks(params.ownerKey).find(
    (task) => task.sourceId === params.requestId,
  );
}
