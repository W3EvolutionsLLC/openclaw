import { PROTOCOL_VERSION, type AgentSideConnection } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "../agents/bash-tools.exec-approval-request.js";
import type { AgentCommandIngressOpts } from "../agents/command/types.js";
import { runWithLocalExecApprovalHandler } from "../agents/local-exec-approval-broker.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { AcpNativeAgent } from "./native-agent.js";

function createHarness(
  executeAgent: (...args: never[]) => Promise<unknown>,
  requestPermission = vi.fn(async () => ({
    outcome: { outcome: "selected" as const, optionId: "allow-once" },
  })),
  deps: {
    sessionCreateRateLimit?: {
      maxRequests?: number;
      windowMs?: number;
    };
  } = {},
) {
  const updates: unknown[] = [];
  let listener: ((event: AgentEventPayload) => void) | undefined;
  const connection = {
    requestPermission,
    sessionUpdate: vi.fn(async (update: unknown) => {
      updates.push(update);
    }),
  } as unknown as AgentSideConnection;
  let id = 0;
  const agent = new AcpNativeAgent(connection, {
    executeAgent: executeAgent as never,
    createId: () => `id-${++id}`,
    resolveAgentId: () => "main",
    subscribeAgentEvents: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    ...deps,
  });
  agent.start();
  return {
    agent,
    connection,
    requestPermission,
    updates,
    emit: (event: AgentEventPayload) => listener?.(event),
  };
}

afterEach(() => {
  delete process.env.BUZZ_PRIVATE_KEY;
});

describe("AcpNativeAgent", () => {
  it("runs the canonical agent in-process with the inherited environment", async () => {
    process.env.BUZZ_PRIVATE_KEY = "test-buzz-key";
    const harnessRef: { current?: ReturnType<typeof createHarness> } = {};
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      expect(process.env.BUZZ_PRIVATE_KEY).toBe("test-buzz-key");
      harnessRef.current?.emit({
        runId: opts.runId,
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { delta: "raw internal stream" },
      });
      return {
        payloads: [{ text: "fallback reply" }],
        meta: { finalAssistantVisibleText: "[[reply_to_current]]local reply" },
      };
    });
    const harness = createHarness(executeAgent);
    harnessRef.current = harness;

    expect(
      harness.agent.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    ).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
    });
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    await expect(
      harness.agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "reply through Buzz" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });

    expect(executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "reply through Buzz",
        sessionKey: `agent:main:acp:${session.sessionId}`,
        cwd: "/tmp/project",
        deliver: false,
        senderIsOwner: false,
        allowModelOverride: false,
        channel: "webchat",
      }),
      expect.any(Object),
    );
    expect(harness.updates).toContainEqual({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "local reply" },
      },
    });
    expect(JSON.stringify(harness.updates)).not.toContain("raw internal stream");
    await harness.agent.shutdown();
    expect(isEmbeddedMode()).toBe(false);
  });

  it("suppresses silent replies and rejects failed agent results", async () => {
    const silentHarness = createHarness(
      vi.fn(async () => ({
        payloads: [{ text: "fallback must not leak" }],
        meta: { finalAssistantVisibleText: "NO_REPLY" },
      })),
    );
    const silentSession = silentHarness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    await expect(
      silentHarness.agent.prompt({
        sessionId: silentSession.sessionId,
        prompt: [{ type: "text", text: "stay silent" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(silentHarness.updates).toEqual([]);
    await silentHarness.agent.shutdown();

    const failedHarness = createHarness(
      vi.fn(async () => ({
        payloads: [{ text: "provider exploded", isError: true }],
        meta: { stopReason: "error", error: { message: "provider exploded" } },
      })),
    );
    const failedSession = failedHarness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    await expect(
      failedHarness.agent.prompt({
        sessionId: failedSession.sessionId,
        prompt: [{ type: "text", text: "fail" }],
      }),
    ).rejects.toThrow("provider exploded");
    expect(failedHarness.updates).toEqual([]);
    await failedHarness.agent.shutdown();
  });

  it("advertises model setup to ACP clients with terminal authentication", async () => {
    const harness = createHarness(vi.fn(async () => ({ payloads: [], meta: {} })));

    expect(
      harness.agent.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      }),
    ).toMatchObject({
      authMethods: [
        {
          id: "openclaw-model-setup",
          type: "terminal",
          args: ["--configure-model"],
        },
      ],
    });

    await harness.agent.shutdown();
  });

  it("relays exec approvals through ACP instead of calling a Gateway", async () => {
    const executeAgent = vi.fn(
      async (opts: AgentCommandIngressOpts) =>
        await runWithLocalExecApprovalHandler({
          handler: opts.localExecApprovalHandler,
          signal: opts.abortSignal,
          run: async () => {
            const registration = await registerExecApprovalRequestForHostOrThrow({
              approvalId: "approval-1",
              command: "buzz messages send --message hello",
              env: { BUZZ_PRIVATE_KEY: "must-not-leak" },
              workdir: "/tmp/project",
              host: "gateway",
              security: "allowlist",
              ask: "always",
              commandHighlighting: false,
            });
            const decision = await resolveRegisteredExecApprovalDecision({
              approvalId: registration.id,
              preResolvedDecision: registration.finalDecision,
            });
            return { payloads: [{ text: decision }], meta: {} };
          },
        }),
    );
    const harness = createHarness(executeAgent);
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });

    await harness.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "send a reply" }],
    });

    expect(harness.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        toolCall: expect.objectContaining({
          kind: "execute",
          rawInput: expect.objectContaining({
            command: "buzz messages send --message hello",
          }),
        }),
      }),
    );
    expect(JSON.stringify(harness.requestPermission.mock.calls)).not.toContain("must-not-leak");
    await harness.agent.shutdown();
  });

  it("cancels an active prompt and closes its session deterministically", async () => {
    const executeAgent = vi.fn(
      async (opts: { abortSignal?: AbortSignal }) =>
        await new Promise((resolve) => {
          opts.abortSignal?.addEventListener("abort", () => resolve({ payloads: [], meta: {} }), {
            once: true,
          });
        }),
    );
    const harness = createHarness(executeAgent);
    const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
    const prompt = harness.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledOnce());

    harness.agent.cancel({ sessionId: session.sessionId });

    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    await expect(harness.agent.closeSession({ sessionId: session.sessionId })).resolves.toEqual({});
    await expect(
      harness.agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "again" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await harness.agent.shutdown();
  });

  it.each(["close", "shutdown"] as const)(
    "does not start a queued prompt after session %s teardown begins",
    async (teardown) => {
      let releaseFirst: (() => void) | undefined;
      const executeAgent = vi.fn(
        async () =>
          await new Promise<{ payloads: never[]; meta: Record<string, never> }>((resolve) => {
            releaseFirst = () => resolve({ payloads: [], meta: {} });
          }),
      );
      const harness = createHarness(executeAgent);
      const session = harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
      const first = harness.agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "first" }],
      });
      await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledOnce());

      const second = harness.agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "second" }],
      });
      const secondResult = expect(second).rejects.toMatchObject({ code: -32602 });
      const teardownResult =
        teardown === "close"
          ? harness.agent.closeSession({ sessionId: session.sessionId })
          : harness.agent.shutdown();

      releaseFirst?.();

      await expect(first).resolves.toEqual({ stopReason: "cancelled" });
      await secondResult;
      await teardownResult;
      expect(executeAgent).toHaveBeenCalledTimes(1);
      if (teardown === "close") {
        await harness.agent.shutdown();
      }
    },
  );

  it("rate limits excessive native session creation bursts", async () => {
    const harness = createHarness(
      vi.fn(async () => ({ payloads: [], meta: {} })),
      undefined,
      {
        sessionCreateRateLimit: {
          maxRequests: 1,
          windowMs: 60_000,
        },
      },
    );

    expect(() => harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] })).not.toThrow();
    expect(() => harness.agent.newSession({ cwd: "/tmp/project", mcpServers: [] })).toThrow(
      /session creation rate limit exceeded/i,
    );

    await harness.agent.shutdown();
  });

  it("rejects unsupported client-owned runtime surfaces", async () => {
    const harness = createHarness(vi.fn(async () => ({ payloads: [], meta: {} })));

    expect(() =>
      harness.agent.newSession({
        cwd: "relative",
        mcpServers: [],
      }),
    ).toThrow("cwd must be an absolute path");
    expect(() =>
      harness.agent.newSession({
        cwd: "/tmp/project",
        mcpServers: [{ name: "extra", command: "server", args: [], env: [] }],
      }),
    ).toThrow("client-supplied MCP servers are not supported");
    await harness.agent.shutdown();
  });
});
