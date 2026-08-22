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
  setTaskCleanupAfterById,
  updateTaskProgressDetailById,
  type TaskRecord,
} from "../../tasks/runtime-internal.js";
import {
  SESSION_BULK_MESSAGE_INTERRUPTED_ERROR,
  SESSION_BULK_MESSAGE_RETENTION_MS,
  SESSION_BULK_MESSAGE_TASK_KIND,
} from "../../tasks/session-bulk-message-task-contract.js";
import { createRunningTaskRunCore, finalizeTaskRunById } from "../../tasks/task-executor.js";
import type { JsonValue } from "../../tasks/task-registry.types.js";
import {
  findSessionBulkMessageTask,
  parseSessionBulkMessageDetail,
  sessionBulkMessageOwnerKey,
  sessionBulkMessageTask,
  sessionBulkMessageTasks,
  type StoredBulkMessageDetail,
  type StoredBulkMessageTarget,
} from "../session-bulk-message-operation-access.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_OPERATION_LIST_LIMIT = 50;

type SendOutcome = {
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

type BulkMessageTargetInput = SessionsOperationTarget & { idempotencyKey?: string };

function storedDetailValue(detail: StoredBulkMessageDetail): JsonValue {
  // SAFETY: StoredBulkMessageDetail is composed only of the task ledger's JSON value domain.
  return structuredClone(detail) as JsonValue;
}

function operationCounts(targets: StoredBulkMessageTarget[]) {
  return {
    pending: targets.filter(
      (target) => target.status === "pending" || target.status === "dispatching",
    ).length,
    accepted: targets.filter((target) => target.status === "accepted").length,
    failed: targets.filter((target) => target.status === "failed").length,
  };
}

function projectTarget(target: StoredBulkMessageTarget): SessionsOperationTargetOutcome {
  const { idempotencyKey: _idempotencyKey, ...outcome } = target;
  return {
    ...outcome,
    status: outcome.status === "dispatching" ? "pending" : outcome.status,
  };
}

function operationStatus(
  task: TaskRecord,
  detail: StoredBulkMessageDetail,
): SessionsOperationStatus {
  if (task.error === SESSION_BULK_MESSAGE_INTERRUPTED_ERROR) {
    return "interrupted";
  }
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
    targets: detail.targets.map(projectTarget),
  };
}

function reconcileRetryOutcome(
  original: { task: TaskRecord; detail: StoredBulkMessageDetail },
  retry: StoredBulkMessageDetail,
): boolean {
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
  delete original.detail.retryRequestId;
  const counts = operationCounts(original.detail.targets);
  const unresolved = counts.failed > 0 || counts.pending > 0;
  return Boolean(
    finalizeTaskRunById({
      taskId: original.task.taskId,
      status: unresolved ? "failed" : "succeeded",
      endedAt: Date.now(),
      terminalSummary: unresolved
        ? `${counts.accepted} accepted, ${counts.failed} failed, ${counts.pending} pending`
        : `${counts.accepted} accepted after retry`,
      terminalOutcome: unresolved ? "blocked" : "succeeded",
      error: undefined,
      detail: storedDetailValue(original.detail),
    }),
  );
}

async function invokeSingleSend(
  options: GatewayRequestHandlerOptions,
  params: {
    target: StoredBulkMessageTarget;
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
  try {
    options.sessionMutationAuthorization?.assertTargetCurrent({
      sessionKey: params.target.key,
      ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof SessionMutationAuthorizationChangedError
          ? error.error
          : errorShape(ErrorCodes.UNAVAILABLE, "session authorization changed before dispatch"),
    };
  }
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
  targets: BulkMessageTargetInput[];
  retryOf?: string;
}): StoredBulkMessageDetail {
  return {
    version: 1,
    kind: "bulk-message",
    requestId: params.requestId,
    message: params.message,
    targets: params.targets.map((target) => ({ ...target, status: "pending" })),
    ...(params.retryOf ? { retryOf: params.retryOf } : {}),
  };
}

function sameOperationInput(
  detail: StoredBulkMessageDetail,
  params: { message: string; targets: BulkMessageTargetInput[] },
) {
  return (
    detail.message === params.message &&
    JSON.stringify(
      detail.targets.map(({ key, agentId, expectedSessionId }) => ({
        key,
        ...(agentId ? { agentId } : {}),
        expectedSessionId,
      })),
    ) ===
      JSON.stringify(
        params.targets.map(({ key, agentId, expectedSessionId }) => ({
          key,
          ...(agentId ? { agentId } : {}),
          expectedSessionId,
        })),
      )
  );
}

function hasDuplicateTargets(targets: SessionsOperationTarget[]): boolean {
  const sessionIds = new Set<string>();
  for (const target of targets) {
    if (sessionIds.has(target.expectedSessionId)) {
      return true;
    }
    sessionIds.add(target.expectedSessionId);
  }
  return false;
}

async function executeBulkMessage(params: {
  options: GatewayRequestHandlerOptions;
  requestId: string;
  message: string;
  targets: BulkMessageTargetInput[];
  retryOf?: string;
}): Promise<
  | { ok: true; operation: SessionsOperation; detail: StoredBulkMessageDetail }
  | { ok: false; error: ErrorShape }
> {
  if (hasDuplicateTargets(params.targets)) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "sessions operation targets must identify distinct sessions",
      ),
    };
  }
  const ownerKey = sessionBulkMessageOwnerKey(params.options.client);
  const existing = findSessionBulkMessageTask({ ownerKey, requestId: params.requestId });
  if (existing) {
    const detail = parseSessionBulkMessageDetail(existing);
    if (!detail || !sameOperationInput(detail, params)) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions operation requestId was reused with different input",
        ),
      };
    }
    return { ok: true, operation: projectOperation(existing, detail), detail };
  }

  const startedAt = Date.now();
  const detail = initialDetail(params);
  const taskRunId = JSON.stringify([ownerKey, params.requestId]);
  const task = createRunningTaskRunCore({
    runtime: "cli",
    taskKind: SESSION_BULK_MESSAGE_TASK_KIND,
    sourceId: params.requestId,
    runId: taskRunId,
    ownerKey,
    requesterSessionKey: "",
    scopeKind: "system",
    label: "Bulk session message",
    task: params.message,
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    startedAt,
    progressSummary: `0/${detail.targets.length} accepted`,
    cleanupAfter: startedAt + SESSION_BULK_MESSAGE_RETENTION_MS,
    detail: storedDetailValue(detail),
  });
  if (!task) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "could not create sessions operation"),
    };
  }

  const persistProgress = () => {
    const counts = operationCounts(detail.targets);
    return updateTaskProgressDetailById({
      taskId: task.taskId,
      detail: storedDetailValue(detail),
      progressSummary: `${counts.accepted}/${detail.targets.length} accepted`,
    });
  };

  // Persist the dispatch key before I/O. If the accepted-outcome write fails,
  // retry reuses that key and the canonical send owner cannot admit a duplicate.
  for (const [index, target] of detail.targets.entries()) {
    const idempotencyKey = target.idempotencyKey ?? `${params.requestId}:${index}`;
    detail.targets[index] = { ...target, status: "dispatching", idempotencyKey };
    if (!persistProgress()) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          "could not persist sessions operation before dispatch",
        ),
      };
    }
    const outcome = await invokeSingleSend(params.options, {
      target,
      message: detail.message,
      idempotencyKey,
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
    if (!persistProgress()) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          "could not persist sessions operation after dispatch",
        ),
      };
    }
  }

  const endedAt = Date.now();
  const counts = operationCounts(detail.targets);
  const failed = counts.failed > 0;
  const finalized = finalizeTaskRunById({
    taskId: task.taskId,
    status: failed ? "failed" : "succeeded",
    endedAt,
    terminalSummary: failed
      ? `${counts.accepted} accepted, ${counts.failed} failed`
      : `${counts.accepted} accepted`,
    terminalOutcome: failed ? "blocked" : "succeeded",
    detail: storedDetailValue(detail),
  });
  if (!finalized) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "could not finalize sessions operation"),
    };
  }
  const retained = setTaskCleanupAfterById({
    taskId: task.taskId,
    cleanupAfter: endedAt + SESSION_BULK_MESSAGE_RETENTION_MS,
  });
  if (!retained) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "could not retain sessions operation"),
    };
  }
  const completed = sessionBulkMessageTask({ taskId: task.taskId, ownerKey });
  return completed
    ? {
        ok: true,
        operation: projectOperation(completed.task, completed.detail),
        detail: completed.detail,
      }
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
  "sessions.operations.list": ({ params, respond, client }) => {
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
    const ownerKey = sessionBulkMessageOwnerKey(client);
    const operations = sessionBulkMessageTasks(ownerKey)
      .toSorted(
        (left, right) =>
          (right.lastEventAt ?? right.createdAt) - (left.lastEventAt ?? left.createdAt),
      )
      .flatMap((task) => {
        const detail = parseSessionBulkMessageDetail(task);
        return detail ? [projectOperationSummary(task, detail)] : [];
      })
      .slice(0, limit);
    respond(true, { operations });
  },
  "sessions.operations.get": ({ params, respond, client }) => {
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
    const found = sessionBulkMessageTask({
      taskId: params.id,
      ownerKey: sessionBulkMessageOwnerKey(client),
    });
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
    const found = sessionBulkMessageTask({
      taskId: options.params.id,
      ownerKey: sessionBulkMessageOwnerKey(options.client),
    });
    if (!found) {
      respondOperationMissing(options.respond, options.params.id);
      return;
    }
    if (found.detail.retryRequestId && found.detail.retryRequestId !== options.params.requestId) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions operation retry is already in progress"),
      );
      return;
    }
    const targets = found.detail.targets
      .filter(
        (target) =>
          target.status === "failed" ||
          target.status === "pending" ||
          target.status === "dispatching",
      )
      .map(({ key, agentId, expectedSessionId, status, idempotencyKey }) => {
        const target: BulkMessageTargetInput = { key, expectedSessionId };
        if (agentId) {
          target.agentId = agentId;
        }
        if (status !== "failed" && idempotencyKey) {
          target.idempotencyKey = idempotencyKey;
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
    found.detail.retryRequestId = options.params.requestId;
    if (
      !updateTaskProgressDetailById({
        taskId: found.task.taskId,
        detail: storedDetailValue(found.detail),
        progressSummary: found.task.progressSummary,
      })
    ) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "could not reserve sessions operation retry"),
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
      if (!reconcileRetryOutcome(found, result.detail)) {
        options.respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "could not persist sessions operation retry result"),
        );
        return;
      }
    } else {
      delete found.detail.retryRequestId;
      updateTaskProgressDetailById({
        taskId: found.task.taskId,
        detail: storedDetailValue(found.detail),
        progressSummary: found.task.progressSummary,
      });
    }
    if (result.ok) {
      options.respond(true, { operation: result.operation });
    } else {
      options.respond(false, undefined, result.error);
    }
  },
};
