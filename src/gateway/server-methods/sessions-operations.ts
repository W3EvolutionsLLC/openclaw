import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsOperation,
  type SessionsOperationStatus,
  type SessionsOperationSummary,
  type SessionsOperationTarget,
  type SessionsOperationTargetOutcome,
  validateSessionsOperationsCreateParams,
  validateSessionsOperationsGetParams,
  validateSessionsOperationsListParams,
  validateSessionsOperationsRetryParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  findTaskByRunId,
  getTaskById,
  listTaskRecords,
  setTaskCleanupAfterById,
  updateTaskProgressDetailById,
  type TaskRecord,
} from "../../tasks/runtime-internal.js";
import {
  createRunningTaskRunCore,
  finalizeTaskRunById,
  finalizeTaskRunByRunIdCore,
} from "../../tasks/task-executor.js";
import type { JsonValue } from "../../tasks/task-registry.types.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const BULK_MESSAGE_TASK_KIND = "sessions.bulk-message";
const BULK_MESSAGE_DETAIL_VERSION = 1;
const BULK_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_OPERATION_LIST_LIMIT = 50;

type StoredBulkMessageDetail = {
  version: 1;
  kind: "bulk-message";
  requestId: string;
  message: string;
  targets: SessionsOperationTargetOutcome[];
  retryOf?: string;
};

type SendOutcome = {
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

function storedDetailValue(detail: StoredBulkMessageDetail): JsonValue {
  // SAFETY: StoredBulkMessageDetail is composed only of the task ledger's JSON value domain.
  return structuredClone(detail) as JsonValue;
}

function parseStoredDetail(task: TaskRecord): StoredBulkMessageDetail | null {
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
    const error =
      isRecord(storedError) &&
      typeof storedError.code === "string" &&
      typeof storedError.message === "string"
        ? errorShape(ErrorCodes.UNAVAILABLE, storedError.message)
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

function operationCounts(targets: SessionsOperationTargetOutcome[]) {
  return {
    pending: targets.filter((target) => target.status === "pending").length,
    accepted: targets.filter((target) => target.status === "accepted").length,
    failed: targets.filter((target) => target.status === "failed").length,
  };
}

function operationStatus(
  task: TaskRecord,
  detail: StoredBulkMessageDetail,
): SessionsOperationStatus {
  if (task.status === "queued" || task.status === "running") {
    return "running";
  }
  if (task.status === "lost" || task.status === "cancelled" || task.status === "timed_out") {
    return "interrupted";
  }
  return operationCounts(detail.targets).failed > 0 ? "needs_attention" : "completed";
}

function projectOperationSummary(
  task: TaskRecord,
  detail: StoredBulkMessageDetail,
): SessionsOperationSummary {
  return {
    id: task.taskId,
    requestId: detail.requestId,
    kind: "bulk-message",
    status: operationStatus(task, detail),
    messagePreview: detail.message.slice(0, 160),
    targetCount: detail.targets.length,
    counts: operationCounts(detail.targets),
    createdAt: task.createdAt,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(detail.retryOf ? { retryOf: detail.retryOf } : {}),
  };
}

function projectOperation(task: TaskRecord, detail: StoredBulkMessageDetail): SessionsOperation {
  return {
    ...projectOperationSummary(task, detail),
    message: detail.message,
    targets: detail.targets,
  };
}

function operationTask(
  taskId: string,
): { task: TaskRecord; detail: StoredBulkMessageDetail } | null {
  const task = getTaskById(taskId);
  if (!task || task.taskKind !== BULK_MESSAGE_TASK_KIND) {
    return null;
  }
  const detail = parseStoredDetail(task);
  return detail ? { task, detail } : null;
}

function reconcileRetryOutcome(
  original: { task: TaskRecord; detail: StoredBulkMessageDetail },
  retry: SessionsOperation,
) {
  const retriedByIdentity = new Map(
    retry.targets.map((target) => [
      `${target.agentId ?? ""}\u0000${target.key}\u0000${target.expectedSessionId}`,
      target,
    ]),
  );
  original.detail.targets = original.detail.targets.map((target) => {
    const retried = retriedByIdentity.get(
      `${target.agentId ?? ""}\u0000${target.key}\u0000${target.expectedSessionId}`,
    );
    return retried ?? target;
  });
  const counts = operationCounts(original.detail.targets);
  const unresolved = counts.failed > 0 || counts.pending > 0;
  finalizeTaskRunById({
    taskId: original.task.taskId,
    status: unresolved ? "failed" : "succeeded",
    endedAt: Date.now(),
    terminalSummary: unresolved
      ? `${counts.accepted} accepted, ${counts.failed} failed, ${counts.pending} pending`
      : `${counts.accepted} accepted after retry`,
    terminalOutcome: unresolved ? "blocked" : "succeeded",
    detail: storedDetailValue(original.detail),
  });
}

async function invokeSingleSend(
  options: GatewayRequestHandlerOptions,
  params: {
    target: SessionsOperationTargetOutcome;
    message: string;
    idempotencyKey: string;
  },
): Promise<SendOutcome> {
  const handler = sessionMessagingHandlers["sessions.send"];
  if (!handler) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "sessions.send is unavailable"),
    };
  }
  let outcome: SendOutcome | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    outcome = { ok, payload, error };
  };
  await handler({
    ...options,
    params: {
      key: params.target.key,
      ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
      expectedSessionId: params.target.expectedSessionId,
      message: params.message,
      idempotencyKey: params.idempotencyKey,
    },
    respond,
  });
  return (
    outcome ?? {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "sessions.send did not respond"),
    }
  );
}

function initialDetail(params: {
  requestId: string;
  message: string;
  targets: SessionsOperationTarget[];
  retryOf?: string;
}): StoredBulkMessageDetail {
  return {
    version: BULK_MESSAGE_DETAIL_VERSION,
    kind: "bulk-message",
    requestId: params.requestId,
    message: params.message,
    targets: params.targets.map((target) => ({ ...target, status: "pending" })),
    ...(params.retryOf ? { retryOf: params.retryOf } : {}),
  };
}

function sameOperationInput(
  detail: StoredBulkMessageDetail,
  params: { message: string; targets: SessionsOperationTarget[] },
) {
  return (
    detail.message === params.message &&
    JSON.stringify(
      detail.targets.map(({ key, agentId, expectedSessionId }) => ({
        key,
        ...(agentId ? { agentId } : {}),
        expectedSessionId,
      })),
    ) === JSON.stringify(params.targets)
  );
}

async function executeBulkMessage(params: {
  options: GatewayRequestHandlerOptions;
  requestId: string;
  message: string;
  targets: SessionsOperationTarget[];
  retryOf?: string;
}): Promise<{ ok: true; operation: SessionsOperation } | { ok: false; error: ErrorShape }> {
  const existing = findTaskByRunId(params.requestId);
  if (existing) {
    const detail = parseStoredDetail(existing);
    if (!detail || !sameOperationInput(detail, params)) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions operation requestId was reused with different input",
        ),
      };
    }
    return { ok: true, operation: projectOperation(existing, detail) };
  }

  const startedAt = Date.now();
  const detail = initialDetail(params);
  const task = createRunningTaskRunCore({
    runtime: "cli",
    taskKind: BULK_MESSAGE_TASK_KIND,
    sourceId: params.requestId,
    runId: params.requestId,
    ownerKey: "",
    requesterSessionKey: "",
    scopeKind: "system",
    label: "Bulk session message",
    task: params.message,
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    startedAt,
    progressSummary: `0/${detail.targets.length} accepted`,
    detail: storedDetailValue(detail),
  });
  if (!task) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "could not create sessions operation"),
    };
  }

  // Persist after each admission: a Gateway restart can then distinguish
  // accepted targets from undispatched targets without replaying successful work.
  for (const [index, target] of detail.targets.entries()) {
    const outcome = await invokeSingleSend(params.options, {
      target,
      message: detail.message,
      idempotencyKey: `${params.requestId}:${index}`,
    });
    const runId = isRecord(outcome.payload)
      ? normalizeOptionalString(outcome.payload.runId)
      : undefined;
    detail.targets[index] = outcome.ok
      ? { ...target, status: "accepted", ...(runId ? { runId } : {}) }
      : {
          ...target,
          status: "failed",
          error: outcome.error ?? errorShape(ErrorCodes.UNAVAILABLE, "sessions.send failed"),
        };
    const counts = operationCounts(detail.targets);
    updateTaskProgressDetailById({
      taskId: task.taskId,
      detail: storedDetailValue(detail),
      progressSummary: `${counts.accepted}/${detail.targets.length} accepted`,
    });
  }

  const endedAt = Date.now();
  const counts = operationCounts(detail.targets);
  const failed = counts.failed > 0;
  finalizeTaskRunByRunIdCore({
    runId: params.requestId,
    runtime: "cli",
    status: failed ? "failed" : "succeeded",
    endedAt,
    progressSummary: `${counts.accepted}/${detail.targets.length} accepted`,
    terminalSummary: failed
      ? `${counts.accepted} accepted, ${counts.failed} failed`
      : `${counts.accepted} accepted`,
    terminalOutcome: failed ? "blocked" : "succeeded",
    detail: storedDetailValue(detail),
    suppressDelivery: true,
  });
  setTaskCleanupAfterById({
    taskId: task.taskId,
    cleanupAfter: endedAt + BULK_MESSAGE_RETENTION_MS,
  });
  const completed = operationTask(task.taskId);
  return completed
    ? { ok: true, operation: projectOperation(completed.task, completed.detail) }
    : {
        ok: false,
        error: errorShape(ErrorCodes.UNAVAILABLE, "sessions operation could not be reloaded"),
      };
}

function respondOperationMissing(respond: RespondFn, id: string) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `sessions operation not found: ${id}`),
  );
}

export const sessionOperationHandlers: GatewayRequestHandlers = {
  "sessions.operations.create": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validateSessionsOperationsCreateParams,
        "sessions.operations.create",
        options.respond,
      )
    ) {
      return;
    }
    const result = await executeBulkMessage({
      options,
      requestId: options.params.requestId,
      message: options.params.message,
      targets: options.params.targets,
    });
    if (result.ok) {
      options.respond(true, { operation: result.operation });
    } else {
      options.respond(false, undefined, result.error);
    }
  },
  "sessions.operations.list": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsOperationsListParams,
        "sessions.operations.list",
        respond,
      )
    ) {
      return;
    }
    const limit = params.limit ?? DEFAULT_OPERATION_LIST_LIMIT;
    const operations = listTaskRecords()
      .filter((task) => task.taskKind === BULK_MESSAGE_TASK_KIND)
      .toSorted(
        (left, right) =>
          (right.lastEventAt ?? right.createdAt) - (left.lastEventAt ?? left.createdAt),
      )
      .flatMap((task) => {
        const detail = parseStoredDetail(task);
        return detail ? [projectOperationSummary(task, detail)] : [];
      })
      .slice(0, limit);
    respond(true, { operations });
  },
  "sessions.operations.get": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsOperationsGetParams,
        "sessions.operations.get",
        respond,
      )
    ) {
      return;
    }
    const found = operationTask(params.id);
    if (!found) {
      respondOperationMissing(respond, params.id);
      return;
    }
    respond(true, { operation: projectOperation(found.task, found.detail) });
  },
  "sessions.operations.retry": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validateSessionsOperationsRetryParams,
        "sessions.operations.retry",
        options.respond,
      )
    ) {
      return;
    }
    const found = operationTask(options.params.id);
    if (!found) {
      respondOperationMissing(options.respond, options.params.id);
      return;
    }
    const targets = found.detail.targets
      .filter((target) => target.status === "failed" || target.status === "pending")
      .map(({ key, agentId, expectedSessionId }) => {
        const target: SessionsOperationTarget = { key, expectedSessionId };
        if (agentId) {
          target.agentId = agentId;
        }
        return target;
      });
    if (targets.length === 0) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions operation has no failed targets to retry"),
      );
      return;
    }
    const result = await executeBulkMessage({
      options,
      requestId: options.params.requestId,
      message: found.detail.message,
      targets,
      retryOf: found.task.taskId,
    });
    if (result.ok) {
      reconcileRetryOutcome(found, result.operation);
    }
    if (result.ok) {
      options.respond(true, { operation: result.operation });
    } else {
      options.respond(false, undefined, result.error);
    }
  },
};
