import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const taskStore = vi.hoisted(() => {
  const tasks = new Map<string, TaskRecord>();
  return {
    tasks,
    create: vi.fn((params: Record<string, unknown>) => {
      const taskId = `task-${tasks.size + 1}`;
      const task = {
        taskId,
        runtime: params.runtime,
        taskKind: params.taskKind,
        sourceId: params.sourceId,
        requesterSessionKey: "",
        ownerKey: "",
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
  updateTaskProgressDetailById: (params: {
    taskId: string;
    detail: TaskRecord["detail"];
    progressSummary?: string;
  }) => {
    const task = taskStore.tasks.get(params.taskId);
    if (!task) {
      return null;
    }
    Object.assign(task, params, { lastEventAt: Date.now() });
    return structuredClone(task);
  },
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

function options(method: string, params: Record<string, unknown>) {
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
    } as unknown as GatewayRequestHandlerOptions,
  };
}

beforeEach(() => {
  taskStore.tasks.clear();
  taskStore.create.mockClear();
  send.mockReset();
  send.mockImplementation(async ({ params, respond }: GatewayRequestHandlerOptions) => {
    if (params.key === "agent:main:failed") {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "session changed" });
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
        }),
      }),
    );
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
    task.status = "lost";
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
});
