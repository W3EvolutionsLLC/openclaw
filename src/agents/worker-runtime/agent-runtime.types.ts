import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { runAgentAttempt, RunAgentAttemptParams } from "../command/attempt-execution.js";

export type AgentRuntimeWorkerRunParams = Omit<
  RunAgentAttemptParams,
  "onAgentEvent" | "onUserMessagePersisted" | "opts"
> & {
  opts: Omit<RunAgentAttemptParams["opts"], "abortSignal">;
};

export type RunAgentAttemptResult = Awaited<ReturnType<typeof runAgentAttempt>>;

export type SerializedWorkerError = {
  name?: string;
  message: string;
  stack?: string;
  code?: string;
};

export type AgentWorkerToParentMessage =
  | {
      type: "agentEvent";
      event: { stream: string; data?: Record<string, unknown>; sessionKey?: string };
    }
  | { type: "userMessagePersisted"; message: Extract<AgentMessage, { role: "user" }> }
  | { type: "result"; result: RunAgentAttemptResult }
  | { type: "error"; error: SerializedWorkerError };

export type ParentToAgentWorkerMessage =
  | { type: "run"; params: AgentRuntimeWorkerRunParams }
  | { type: "abort"; reason?: unknown };
