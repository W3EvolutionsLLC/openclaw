/** Regression matrix for notify-on-exit acknowledgement ordering (#120488). */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { getFinishedSession, markBackgrounded } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess, type ExecProcessOutcome } from "./bash-tools.exec-runtime.js";
import { createProcessTool } from "./bash-tools.process.js";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const supervisorMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  getRecord: vi.fn(),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorMock.spawn,
    getRecord: supervisorMock.getRecord,
  }),
}));

const DEFAULT_SESSION_KEY = "agent:main:main";
const COMPLETED_EXIT: RunExit = {
  reason: "exit",
  exitCode: 0,
  exitSignal: null,
  durationMs: 1,
  stdout: "",
  stderr: "",
  timedOut: false,
  noOutputTimedOut: false,
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type NotifyProcessOptions = {
  output?: string;
  sessionKey?: string;
  mainKey?: string;
  sessionScope?: "per-sender" | "global";
  onSettledBeforeNotify?: (outcome: ExecProcessOutcome) => void;
};

async function startNotifyProcess(options: NotifyProcessOptions = {}) {
  const exit = createDeferred<RunExit>();
  const output = options.output ?? "notify";
  supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput): Promise<ManagedRun> => {
    input.onStdout?.(`${output}\n`);
    return {
      runId: `run-${supervisorMock.spawn.mock.calls.length}`,
      startedAtMs: Date.now(),
      pid: 123,
      wait: async () => await exit.promise,
      cancel: vi.fn(),
    };
  });
  const run = await runExecProcess({
    command: output,
    workdir: process.cwd(),
    env: {},
    usePty: false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: true,
    notifyOnExitEmptySuccess: false,
    sessionKey: options.sessionKey ?? DEFAULT_SESSION_KEY,
    mainKey: options.mainKey,
    sessionScope: options.sessionScope,
    timeoutSec: null,
    onSettledBeforeNotify: options.onSettledBeforeNotify,
  });
  markBackgrounded(run.session);
  return {
    run,
    finish: async () => {
      exit.resolve(COMPLETED_EXIT);
      await run.promise;
    },
  };
}

const processTool = createProcessTool();

async function executeProcess(action: "poll" | "clear", sessionId: string, timeout?: number) {
  return processTool.execute(`call-${action}-${sessionId}`, {
    action,
    sessionId,
    ...(timeout === undefined ? {} : { timeout }),
  });
}

function readStatus(result: Awaited<ReturnType<typeof executeProcess>>) {
  return (result.details as { status?: string }).status;
}

function completionEvent(sessionId: string, queueKey = DEFAULT_SESSION_KEY) {
  return peekSystemEventEntries(queueKey).find((event) =>
    event.text.includes(sessionId.slice(0, 8)),
  );
}

function completionEventWithOutput(output: string) {
  return peekSystemEventEntries(DEFAULT_SESSION_KEY).find((event) =>
    event.text.includes(`:: ${output}`),
  );
}

beforeEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  requestHeartbeatMock.mockClear();
  supervisorMock.spawn.mockReset();
  supervisorMock.getRecord.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

describe("notify-on-exit acknowledgement", () => {
  it("suppresses the completion event and wake when poll wins the notify race", async () => {
    let sessionId = "";
    let pollPromise: ReturnType<typeof executeProcess> | undefined;
    const process = await startNotifyProcess({
      onSettledBeforeNotify: () => {
        pollPromise = executeProcess("poll", sessionId);
      },
    });
    sessionId = process.run.session.id;

    await process.finish();
    const poll = await expectDefined(pollPromise, "poll-before-notify test invariant");

    expect(readStatus(poll)).toBe("completed");
    expect(getFinishedSession(sessionId)?.status).toBe("completed");
    expect(peekSystemEventEntries(DEFAULT_SESSION_KEY)).toStrictEqual([]);
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("removes only the acknowledged completion from its remapped queue", async () => {
    const queueKey = "agent:ops:primary";
    const before = expectDefined(
      enqueueSystemEventEntry("unrelated before", { sessionKey: queueKey }),
      "leading event test invariant",
    );
    const process = await startNotifyProcess({
      sessionKey: "agent:ops:cron:nightly:run:abc",
      mainKey: "primary",
      sessionScope: "per-sender",
    });
    await process.finish();
    const sessionId = process.run.session.id;
    expect(completionEvent(sessionId, queueKey)).toBeDefined();
    const after = expectDefined(
      enqueueSystemEventEntry("unrelated after", { sessionKey: queueKey }),
      "trailing event test invariant",
    );

    expect(readStatus(await executeProcess("poll", sessionId))).toBe("completed");
    expect(peekSystemEventEntries(queueKey)).toStrictEqual([before, after]);
    expect(readStatus(await executeProcess("poll", sessionId))).toBe("completed");
    expect(peekSystemEventEntries(queueKey)).toStrictEqual([before, after]);
  });

  it("leaves an existing completion when the producer enqueue is deduplicated", async () => {
    const process = await startNotifyProcess();
    const sessionId = process.run.session.id;
    const existing = expectDefined(
      enqueueSystemEventEntry(`Exec completed (${sessionId.slice(0, 8)}, code 0) :: notify`, {
        sessionKey: DEFAULT_SESSION_KEY,
      }),
      "prequeued completion test invariant",
    );

    await process.finish();
    expect(readStatus(await executeProcess("poll", sessionId))).toBe("completed");
    expect(peekSystemEventEntries(DEFAULT_SESSION_KEY)).toStrictEqual([existing]);
  });

  it("acknowledges a live completion observed by a waiting poll", async () => {
    const process = await startNotifyProcess();
    const sessionId = process.run.session.id;
    const pollPromise = executeProcess("poll", sessionId, 1000);

    await process.finish();
    expect(readStatus(await pollPromise)).toBe("completed");
    expect(completionEvent(sessionId)).toBeUndefined();
  });

  it("isolates completion acknowledgements for processes sharing a queue", async () => {
    const first = await startNotifyProcess({ output: "first" });
    const second = await startNotifyProcess({ output: "second" });
    await first.finish();
    await second.finish();
    const firstId = first.run.session.id;

    expect(completionEventWithOutput("first")).toBeDefined();
    expect(completionEventWithOutput("second")).toBeDefined();
    await executeProcess("poll", firstId);

    expect(completionEventWithOutput("first")).toBeUndefined();
    expect(completionEventWithOutput("second")).toBeDefined();
  });

  it("preserves an unpolled completion when its finished session is cleared", async () => {
    const process = await startNotifyProcess();
    await process.finish();
    const sessionId = process.run.session.id;
    expect(completionEvent(sessionId)).toBeDefined();

    expect(readStatus(await executeProcess("clear", sessionId))).toBe("completed");
    expect(getFinishedSession(sessionId)).toBeUndefined();
    expect(completionEvent(sessionId)).toBeDefined();
  });
});
