import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_BULK_MESSAGE_INTERRUPTED_ERROR,
  SESSION_BULK_MESSAGE_RETENTION_MS,
} from "../../tasks/session-bulk-message-task-contract.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

const taskStore = vi.hoisted(() => {
  const tasks = new Map<string, TaskRecord>();
  let progressCall = 0;
  return {
    tasks,
    failProgressAt: null as number | null,
    resetProgress: () => {
      progressCall = 0;
    },
    updateProgress: vi.fn(
      (params: { taskId: string; detail: TaskRecord["detail"]; progressSummary?: string }) => {
        progressCall += 1;
        if (progressCall === taskStore.failProgressAt) {
          return null;
        }
        const task = tasks.get(params.taskId);
        if (!task) {
          return null;
        }
        Object.assign(task, params, { lastEventAt: Date.now() });
        return structuredClone(task);
      },
    ),
    create: vi.fn((params: Record<string, unknown>) => {
      const taskId = `task-${tasks.size + 1}`;
      const task = {
        taskId,
        runtime: params.runtime,
        taskKind: params.taskKind,
        sourceId: params.sourceId,
        requesterSessionKey: params.requesterSessionKey ?? "",
        ownerKey: params.ownerKey ?? "",
        scopeKind: "system",
        runId: params.runId,
        label: params.label,
        task: params.task,
        status: params.status ?? "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
        startedAt: params.startedAt,
        lastEventAt: 1,
        progressSummary: params.progressSummary,
        cleanupAfter: params.cleanupAfter,
        detail: params.detail,
      } as TaskRecord;
      tasks.set(taskId, task);
      return structuredClone(task);
    }),
  };
});

const send = vi.hoisted(() => vi.fn());

vi.mock("../../tasks/runtime-internal.js", () => ({
  findTaskByRunId: (runId: string) =>
    [...taskStore.tasks.values()].find((task) => task.runId === runId),
  getTaskById: (taskId: string) => taskStore.tasks.get(taskId),
  listTaskRecords: () => [...taskStore.tasks.values()],
  updateTaskProgressDetailById: taskStore.updateProgress,
  setTaskCleanupAfterById: (params: { taskId: string; cleanupAfter: number }) => {
    const task = taskStore.tasks.get(params.taskId);
    if (!task) {
      return null;
    }
    task.cleanupAfter = params.cleanupAfter;
    return structuredClone(task);
  },
}));

vi.mock("../../tasks/task-executor.js", () => ({
  createRunningTaskRunCore: taskStore.create,
  finalizeTaskRunByRunIdCore: (params: {
    runId: string;
    status: TaskRecord["status"];
    detail: TaskRecord["detail"];
    endedAt: number;
  }) => {
    const task = [...taskStore.tasks.values()].find(
      (candidate) => candidate.runId === params.runId,
    );
    if (!task) {
      return [];
    }
    Object.assign(task, params, { lastEventAt: params.endedAt });
    return [structuredClone(task)];
  },
  finalizeTaskRunById: (params: {
    taskId: string;
    status: TaskRecord["status"];
    detail: TaskRecord["detail"];
    endedAt: number;
  }) => {
    const task = taskStore.tasks.get(params.taskId);
    if (!task) {
      return null;
    }
    Object.assign(task, params, { lastEventAt: params.endedAt });
    return structuredClone(task);
  },
}));

vi.mock("./sessions-messaging.js", () => ({
  sessionMessagingHandlers: {
    "sessions.send": send,
  },
}));

import { sessionOperationHandlers } from "./sessions-operations.js";

function profileClient(profileId: string): GatewayClient {
  return {
    connect: { scopes: ["operator.read", "operator.write"] },
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
  } as GatewayClient;
}

function options(
  method: string,
  params: Record<string, unknown>,
  overrides: Partial<GatewayRequestHandlerOptions> = {},
) {
  const respond = vi.fn();
  return {
    respond,
    options: {
      req: { type: "req", id: "request", method },
      params,
      respond,
      context: {},
      client: null,
      isWebchatConnect: () => false,
      ...overrides,
    } as unknown as GatewayRequestHandlerOptions,
  };
}

beforeEach(() => {
  taskStore.tasks.clear();
  taskStore.create.mockClear();
  taskStore.failProgressAt = null;
  taskStore.resetProgress();
  taskStore.updateProgress.mockClear();
  send.mockReset();
  send.mockImplementation(async ({ params, respond }: GatewayRequestHandlerOptions) => {
    if (params.key === "agent:main:failed") {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "session changed",
        details: { reason: "SESSION_MUTATION_AUTHORIZATION_CHANGED" },
        retryable: true,
        retryAfterMs: 250,
      });
    } else {
      respond(true, { runId: `run:${String(params.key)}` });
    }
  });
});

describe("sessions operations", () => {
  it("freezes fenced targets and records ordered partial outcomes", async () => {
    const { options: request, respond } = options("sessions.operations.create", {
      requestId: "bulk-one",
      message: "Report status.",
      targets: [
        {
          key: "agent:main:accepted",
          expectedSessionId: "session-accepted",
        },
        {
          key: "agent:main:failed",
          expectedSessionId: "session-failed",
        },
      ],
    });

    await sessionOperationHandlers["sessions.operations.create"]?.(request);

    expect(send.mock.calls.map(([call]) => call.params)).toEqual([
      expect.objectContaining({
        key: "agent:main:accepted",
        expectedSessionId: "session-accepted",
        idempotencyKey: "bulk-one:0",
      }),
      expect.objectContaining({
        key: "agent:main:failed",
        expectedSessionId: "session-failed",
        idempotencyKey: "bulk-one:1",
      }),
    ]);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        operation: expect.objectContaining({
          status: "needs_attention",
          counts: { pending: 0, accepted: 1, failed: 1 },
          targets: expect.arrayContaining([
            expect.objectContaining({
              status: "failed",
              error: {
                code: "INVALID_REQUEST",
                message: "session changed",
                details: { reason: "SESSION_MUTATION_AUTHORIZATION_CHANGED" },
                retryable: true,
                retryAfterMs: 250,
              },
            }),
          ]),
        }),
      }),
    );
    const createParams = taskStore.create.mock.calls[0]?.[0];
    expect(Number(createParams?.cleanupAfter) - Number(createParams?.startedAt)).toBe(
      SESSION_BULK_MESSAGE_RETENTION_MS,
    );
  });

  it("revalidates every target immediately before dispatch", async () => {
    const assertTargetCurrent = vi.fn(({ sessionKey }: { sessionKey: string }) => {
      if (sessionKey === "agent:main:revoked") {
        throw new SessionMutationAuthorizationChangedError({
          code: "INVALID_REQUEST",
          message: "session is read-only for this connection",
        });
      }
    });
    const created = options(
      "sessions.operations.create",
      {
        requestId: "bulk-revalidate",
        message: "Report status.",
        targets: [
          { key: "agent:main:accepted", expectedSessionId: "session-accepted" },
          { key: "agent:main:revoked", expectedSessionId: "session-revoked" },
        ],
      },
      { sessionMutationAuthorization: { assertCurrent: vi.fn(), assertTargetCurrent } },
    );

    await sessionOperationHandlers["sessions.operations.create"]?.(created.options);

    expect(assertTargetCurrent.mock.calls.map(([target]) => target.sessionKey)).toEqual([
      "agent:main:accepted",
      "agent:main:revoked",
    ]);
    expect(send.mock.calls.map(([call]) => call.params.key)).toEqual(["agent:main:accepted"]);
    expect(created.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        operation: expect.objectContaining({
          counts: { pending: 0, accepted: 1, failed: 1 },
        }),
      }),
    );
  });

  it("rejects duplicate session identities before creating or dispatching", async () => {
    const created = options("sessions.operations.create", {
      requestId: "bulk-duplicate",
      message: "Report status.",
      targets: [
        { key: "agent:main:first-alias", expectedSessionId: "session-same" },
        { key: "agent:main:second-alias", expectedSessionId: "session-same" },
      ],
    });

    await sessionOperationHandlers["sessions.operations.create"]?.(created.options);

    expect(created.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "sessions operation targets must identify distinct sessions",
      }),
    );
    expect(taskStore.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("retries only failed or undispatched targets", async () => {
    const created = options("sessions.operations.create", {
      requestId: "bulk-one",
      message: "Report status.",
      targets: [
        { key: "agent:main:accepted", expectedSessionId: "session-accepted" },
        { key: "agent:main:failed", expectedSessionId: "session-failed" },
      ],
    });
    await sessionOperationHandlers["sessions.operations.create"]?.(created.options);
    const operationId = taskStore.tasks.values().next().value?.taskId;
    if (!operationId) {
      throw new Error("Expected created bulk operation");
    }
    send.mockClear();
    send.mockImplementation(async ({ params, respond }: GatewayRequestHandlerOptions) => {
      respond(true, { runId: `retry:${String(params.key)}` });
    });

    const retry = options("sessions.operations.retry", {
      id: operationId,
      requestId: "bulk-retry",
    });
    await sessionOperationHandlers["sessions.operations.retry"]?.(retry.options);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].params).toEqual(
      expect.objectContaining({
        key: "agent:main:failed",
        expectedSessionId: "session-failed",
        idempotencyKey: "bulk-retry:0",
      }),
    );
    expect(taskStore.tasks.get(operationId)?.status).toBe("succeeded");
  });

  it("reserves retry targets before concurrent callers can dispatch them", async () => {
    const created = options("sessions.operations.create", {
      requestId: "bulk-concurrent",
      message: "Report status.",
      targets: [{ key: "agent:main:failed", expectedSessionId: "session-failed" }],
    });
    await sessionOperationHandlers["sessions.operations.create"]?.(created.options);
    const operationId = taskStore.tasks.values().next().value?.taskId;
    if (!operationId) {
      throw new Error("Expected created bulk operation");
    }
    let releaseSend = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    send.mockClear();
    send.mockImplementation(async ({ params, respond }: GatewayRequestHandlerOptions) => {
      await sendGate;
      respond(true, { runId: `retry:${String(params.key)}` });
    });

    const first = options("sessions.operations.retry", {
      id: operationId,
      requestId: "bulk-concurrent-first",
    });
    const firstRetry = sessionOperationHandlers["sessions.operations.retry"]?.(first.options);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const second = options("sessions.operations.retry", {
      id: operationId,
      requestId: "bulk-concurrent-second",
    });
    await sessionOperationHandlers["sessions.operations.retry"]?.(second.options);

    expect(second.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "sessions operation retry is already in progress" }),
    );
    expect(send).toHaveBeenCalledOnce();
    releaseSend();
    await firstRetry;
  });

  it("stops dispatch and preserves its idempotency key when progress persistence fails", async () => {
    taskStore.failProgressAt = 2;
    const created = options("sessions.operations.create", {
      requestId: "bulk-persist",
      message: "Report status.",
      targets: [
        { key: "agent:main:first", expectedSessionId: "session-first" },
        { key: "agent:main:second", expectedSessionId: "session-second" },
      ],
    });

    await sessionOperationHandlers["sessions.operations.create"]?.(created.options);

    expect(send).toHaveBeenCalledOnce();
    expect(created.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "could not persist sessions operation after dispatch",
      }),
    );
    const task = taskStore.tasks.values().next().value;
    expect(task?.detail).toMatchObject({
      targets: [{ status: "dispatching", idempotencyKey: "bulk-persist:0" }, { status: "pending" }],
    });
  });

  it("projects unfinished restored work as interrupted instead of auto-resuming it", async () => {
    const created = options("sessions.operations.create", {
      requestId: "bulk-interrupted",
      message: "Report status.",
      targets: [{ key: "agent:main:accepted", expectedSessionId: "session-accepted" }],
    });
    await sessionOperationHandlers["sessions.operations.create"]?.(created.options);
    const task = taskStore.tasks.values().next().value;
    if (!task || !task.detail || typeof task.detail !== "object" || Array.isArray(task.detail)) {
      throw new Error("Expected stored bulk operation detail");
    }
    task.status = "failed";
    task.error = SESSION_BULK_MESSAGE_INTERRUPTED_ERROR;
    task.detail = {
      ...task.detail,
      targets: [
        { key: "agent:main:accepted", expectedSessionId: "session-accepted", status: "pending" },
      ],
    };

    const listed = options("sessions.operations.list", {});
    await sessionOperationHandlers["sessions.operations.list"]?.(listed.options);

    expect(listed.respond).toHaveBeenCalledWith(true, {
      operations: [
        expect.objectContaining({
          status: "interrupted",
          counts: { pending: 1, accepted: 0, failed: 0 },
        }),
      ],
    });
  });

  it("keeps history, details, and retry handles private to the creating profile", async () => {
    const alice = profileClient("alice");
    const bob = profileClient("bob");
    const created = options(
      "sessions.operations.create",
      {
        requestId: "bulk-private",
        message: "Private operation message.",
        targets: [{ key: "agent:main:failed", expectedSessionId: "session-failed" }],
      },
      { client: alice },
    );
    await sessionOperationHandlers["sessions.operations.create"]?.(created.options);
    const operationId = taskStore.tasks.values().next().value?.taskId;
    if (!operationId) {
      throw new Error("Expected created bulk operation");
    }
    send.mockClear();

    const bobList = options("sessions.operations.list", {}, { client: bob });
    const bobGet = options("sessions.operations.get", { id: operationId }, { client: bob });
    const bobRetry = options(
      "sessions.operations.retry",
      { id: operationId, requestId: "bulk-private-retry" },
      { client: bob },
    );
    await sessionOperationHandlers["sessions.operations.list"]?.(bobList.options);
    await sessionOperationHandlers["sessions.operations.get"]?.(bobGet.options);
    await sessionOperationHandlers["sessions.operations.retry"]?.(bobRetry.options);

    expect(bobList.respond).toHaveBeenCalledWith(true, { operations: [] });
    expect(bobGet.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: `sessions operation not found: ${operationId}` }),
    );
    expect(bobRetry.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: `sessions operation not found: ${operationId}` }),
    );
    expect(send).not.toHaveBeenCalled();

    const aliceList = options("sessions.operations.list", {}, { client: alice });
    await sessionOperationHandlers["sessions.operations.list"]?.(aliceList.options);
    expect(aliceList.respond).toHaveBeenCalledWith(true, {
      operations: [
        expect.objectContaining({ id: operationId, messagePreview: "Private operation message." }),
      ],
    });
  });
});
