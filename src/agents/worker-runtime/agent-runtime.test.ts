import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RunAgentAttemptParams } from "../command/attempt-execution.js";
import {
  AgentWorkerUnsupportedParamsError,
  runAgentAttemptInWorker,
  shouldRunAgentAttemptInWorker,
} from "./agent-runtime.js";

function createFixtureWorkerUrl(): URL {
  const source = `
    import { parentPort } from "node:worker_threads";

    let runStarted = false;

    function post(message) {
      parentPort.postMessage(message);
    }

    parentPort.on("message", (message) => {
      if (message.type === "abort") {
        post({ type: "error", error: { name: "AbortError", message: "aborted:" + String(message.reason ?? "") } });
        return;
      }

      if (message.type !== "run" || runStarted) {
        return;
      }

      runStarted = true;
      post({
        type: "agentEvent",
        event: {
          stream: "lifecycle",
          sessionKey: message.params.sessionKey,
          data: { phase: "fixture", runId: message.params.runId }
        }
      });
      post({
        type: "userMessagePersisted",
        message: { role: "user", content: [{ type: "text", text: message.params.body }] }
      });

      if (message.params.body === "throw") {
        post({ type: "error", error: { name: "FixtureError", message: "fixture failed", code: "FIXTURE" } });
        return;
      }
      if (message.params.body === "wait") {
        return;
      }

      post({
        type: "result",
        result: {
          payloads: [{ text: "worker:" + message.params.body }],
          meta: {
            durationMs: 1,
            finalAssistantVisibleText: "worker:" + message.params.body,
            agentMeta: {
              sessionId: message.params.sessionId,
              provider: message.params.providerOverride ?? "fixture",
              model: message.params.modelOverride ?? "fixture-model"
            },
            executionTrace: { runner: "embedded" }
          }
        }
      });
    });
  `;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

async function makeWorkerParams(body: string): Promise<RunAgentAttemptParams> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-worker-"));
  tmpDirs.push(tmpDir);
  return {
    providerOverride: "openai",
    originalProvider: "openai",
    modelOverride: "gpt-5.5",
    cfg: {} as OpenClawConfig,
    sessionEntry: undefined,
    sessionId: "session-worker-test",
    sessionKey: "agent:main:worker-test",
    sessionAgentId: "main",
    sessionFile: path.join(tmpDir, "session.jsonl"),
    workspaceDir: tmpDir,
    body,
    isFallbackRetry: false,
    resolvedThinkLevel: "medium",
    timeoutMs: 1_000,
    runId: "run-worker-test",
    opts: { message: body, senderIsOwner: false },
    runContext: {} as RunAgentAttemptParams["runContext"],
    spawnedBy: undefined,
    messageChannel: undefined,
    skillsSnapshot: undefined,
    resolvedVerboseLevel: undefined,
    agentDir: tmpDir,
    onAgentEvent: vi.fn(),
    authProfileProvider: "openai",
    sessionHasHistory: false,
  };
}

const tmpDirs: string[] = [];

describe("agent runtime worker bridge", () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("recognizes config and explicit environment overrides", () => {
    expect(
      shouldRunAgentAttemptInWorker({
        config: {
          agents: { defaults: { experimental: { runtimeIsolation: { mode: "worker" } } } },
        } as OpenClawConfig,
        env: {},
      }),
    ).toBe(true);
    expect(
      shouldRunAgentAttemptInWorker({
        config: {
          agents: { defaults: { experimental: { runtimeIsolation: { mode: "worker" } } } },
        } as OpenClawConfig,
        env: { OPENCLAW_AGENT_RUNTIME_WORKER: "0" },
      }),
    ).toBe(false);
    expect(
      shouldRunAgentAttemptInWorker({
        config: {} as OpenClawConfig,
        env: { OPENCLAW_AGENT_RUNTIME_WORKER: "yes" },
      }),
    ).toBe(true);
    expect(
      shouldRunAgentAttemptInWorker({
        config: {} as OpenClawConfig,
        env: { OPENCLAW_AGENT_WORKER_EXPERIMENT: "1" },
      }),
    ).toBe(true);
  });

  it("runs an agent attempt through a real worker and proxies supported callbacks", async () => {
    const onAgentEvent = vi.fn();
    const onUserMessagePersisted = vi.fn();

    const result = await runAgentAttemptInWorker(
      {
        ...(await makeWorkerParams("hello")),
        onAgentEvent,
        onUserMessagePersisted,
      },
      { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
    );

    expect(result.payloads?.[0]?.text).toBe("worker:hello");
    expect(result.meta.agentMeta).toMatchObject({
      sessionId: "session-worker-test",
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      sessionKey: "agent:main:worker-test",
      data: { phase: "fixture", runId: "run-worker-test" },
    });
    expect(onUserMessagePersisted).toHaveBeenCalledWith({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("propagates structured worker errors", async () => {
    await expect(
      runAgentAttemptInWorker(await makeWorkerParams("throw"), {
        workerUrl: createFixtureWorkerUrl(),
        execArgv: [],
        usePermissions: false,
      }),
    ).rejects.toMatchObject({
      name: "FixtureError",
      message: "fixture failed",
      code: "FIXTURE",
    });
  });

  it("forwards aborts into the worker", async () => {
    const controller = new AbortController();
    const promise = runAgentAttemptInWorker(
      {
        ...(await makeWorkerParams("wait")),
        opts: { message: "wait", senderIsOwner: false, abortSignal: controller.signal },
      },
      { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
    );

    controller.abort("stop");

    await expect(promise).rejects.toMatchObject({
      name: "AbortError",
      message: "aborted:stop",
    });
  });

  it("rejects invalid abort signal params before spawning a worker", async () => {
    await expect(
      runAgentAttemptInWorker(
        {
          ...(await makeWorkerParams("hello")),
          opts: {
            message: "hello",
            senderIsOwner: false,
            abortSignal: "bad" as unknown as AbortSignal,
          },
        },
        { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
      ),
    ).rejects.toBeInstanceOf(AgentWorkerUnsupportedParamsError);
  });
});
