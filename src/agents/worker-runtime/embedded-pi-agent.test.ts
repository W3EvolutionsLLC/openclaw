import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import {
  AgentWorkerUnsupportedParamsError,
  runEmbeddedPiAgentInWorker,
  shouldRunEmbeddedPiAgentInWorker,
} from "./embedded-pi-agent.js";

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
      post({ type: "executionStarted" });
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
        message: { role: "user", content: [{ type: "text", text: message.params.prompt }] }
      });

      if (message.params.prompt === "throw") {
        post({ type: "error", error: { name: "FixtureError", message: "fixture failed", code: "FIXTURE" } });
        return;
      }
      if (message.params.prompt === "wait") {
        return;
      }

      post({
        type: "result",
        result: {
          payloads: [{ text: "worker:" + message.params.prompt }],
          meta: {
            durationMs: 1,
            finalAssistantVisibleText: "worker:" + message.params.prompt,
            agentMeta: {
              sessionId: message.params.sessionId,
              provider: message.params.provider ?? "fixture",
              model: message.params.model ?? "fixture-model"
            },
            executionTrace: { runner: "embedded" }
          }
        }
      });
    });
  `;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

async function makeWorkerParams(prompt: string): Promise<RunEmbeddedPiAgentParams> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-worker-"));
  tmpDirs.push(tmpDir);
  return {
    sessionId: "session-worker-test",
    sessionKey: "agent:main:worker-test",
    agentId: "main",
    sessionFile: path.join(tmpDir, "session.jsonl"),
    workspaceDir: tmpDir,
    agentDir: tmpDir,
    prompt,
    provider: "openai",
    model: "gpt-5.5",
    timeoutMs: 1_000,
    runId: "run-worker-test",
  };
}

const tmpDirs: string[] = [];

describe("embedded PI agent worker bridge", () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("recognizes explicit opt-in environment values", () => {
    expect(shouldRunEmbeddedPiAgentInWorker({ OPENCLAW_AGENT_WORKER_EXPERIMENT: "1" })).toBe(true);
    expect(shouldRunEmbeddedPiAgentInWorker({ OPENCLAW_AGENT_WORKER_EXPERIMENT: "true" })).toBe(
      true,
    );
    expect(shouldRunEmbeddedPiAgentInWorker({ OPENCLAW_AGENT_WORKER_EXPERIMENT: "yes" })).toBe(
      true,
    );
    expect(shouldRunEmbeddedPiAgentInWorker({ OPENCLAW_AGENT_WORKER_EXPERIMENT: "0" })).toBe(false);
  });

  it("runs through a real worker and proxies supported callbacks", async () => {
    const params = await makeWorkerParams("hello");
    const onExecutionStarted = vi.fn();
    const onAgentEvent = vi.fn();
    const onUserMessagePersisted = vi.fn();

    const result = await runEmbeddedPiAgentInWorker(
      {
        ...params,
        onExecutionStarted,
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
    expect(onExecutionStarted).toHaveBeenCalledOnce();
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
      runEmbeddedPiAgentInWorker(await makeWorkerParams("throw"), {
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
    const promise = runEmbeddedPiAgentInWorker(
      {
        ...(await makeWorkerParams("wait")),
        abortSignal: controller.signal,
      },
      { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
    );

    controller.abort("stop");

    await expect(promise).rejects.toMatchObject({
      name: "AbortError",
      message: "aborted:stop",
    });
  });

  it("rejects unsupported streaming callbacks before spawning a worker", async () => {
    await expect(
      runEmbeddedPiAgentInWorker(
        {
          ...(await makeWorkerParams("hello")),
          onPartialReply: () => {},
        },
        { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
      ),
    ).rejects.toBeInstanceOf(AgentWorkerUnsupportedParamsError);
  });
});
