import { parentPort } from "node:worker_threads";
import { runEmbeddedPiAgent } from "../pi-embedded.js";
import type {
  AgentWorkerToParentMessage,
  ParentToAgentWorkerMessage,
} from "./embedded-pi-agent.types.js";

function serializeWorkerError(error: unknown): AgentWorkerToParentMessage {
  if (error instanceof Error) {
    const code =
      typeof (error as Error & { code?: unknown }).code === "string"
        ? (error as Error & { code: string }).code
        : undefined;
    return {
      type: "error",
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(code ? { code } : {}),
      },
    };
  }
  return { type: "error", error: { message: String(error) } };
}

function post(message: AgentWorkerToParentMessage): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads MessagePort has no targetOrigin.
  parentPort?.postMessage(message);
}

let abortController: AbortController | undefined;

parentPort?.on("message", (message: ParentToAgentWorkerMessage) => {
  if (message.type === "abort") {
    abortController?.abort(message.reason);
    return;
  }

  if (message.type !== "run") {
    return;
  }

  abortController = new AbortController();
  void runEmbeddedPiAgent({
    ...message.params,
    abortSignal: abortController.signal,
    onExecutionStarted: () => {
      post({ type: "executionStarted" });
    },
    onAgentEvent: (event) => {
      post({ type: "agentEvent", event });
    },
    onUserMessagePersisted: (persisted) => {
      post({ type: "userMessagePersisted", message: persisted });
    },
  })
    .then((result) => {
      post({ type: "result", result });
    })
    .catch((error: unknown) => {
      post(serializeWorkerError(error));
    });
});
