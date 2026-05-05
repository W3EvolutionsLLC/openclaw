import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";

export type EmbeddedPiWorkerRunParams = Omit<
  RunEmbeddedPiAgentParams,
  | "abortSignal"
  | "enqueue"
  | "onAgentEvent"
  | "onAssistantMessageStart"
  | "onBlockReply"
  | "onBlockReplyFlush"
  | "onExecutionStarted"
  | "onPartialReply"
  | "onReasoningEnd"
  | "onReasoningStream"
  | "onToolResult"
  | "onUserMessagePersisted"
  | "replyOperation"
  | "shouldEmitToolOutput"
  | "shouldEmitToolResult"
>;

export type SerializedWorkerError = {
  name?: string;
  message: string;
  stack?: string;
  code?: string;
};

export type AgentWorkerToParentMessage =
  | {
      type: "agentEvent";
      event: { stream: string; data: Record<string, unknown>; sessionKey?: string };
    }
  | { type: "executionStarted" }
  | { type: "userMessagePersisted"; message: Extract<AgentMessage, { role: "user" }> }
  | { type: "result"; result: EmbeddedPiRunResult }
  | { type: "error"; error: SerializedWorkerError };

export type ParentToAgentWorkerMessage =
  | { type: "run"; params: EmbeddedPiWorkerRunParams }
  | { type: "abort"; reason?: unknown };
