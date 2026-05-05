import { Worker } from "node:worker_threads";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import type {
  AgentWorkerToParentMessage,
  EmbeddedPiWorkerRunParams,
} from "./embedded-pi-agent.types.js";
import { buildAgentWorkerPermissionExecArgv } from "./permissions.js";

const SUPPORTED_CALLBACK_KEYS = new Set<keyof RunEmbeddedPiAgentParams>([
  "abortSignal",
  "onAgentEvent",
  "onExecutionStarted",
  "onUserMessagePersisted",
]);

const CALLBACK_KEYS: Array<keyof RunEmbeddedPiAgentParams> = [
  "abortSignal",
  "enqueue",
  "onAgentEvent",
  "onAssistantMessageStart",
  "onBlockReply",
  "onBlockReplyFlush",
  "onExecutionStarted",
  "onPartialReply",
  "onReasoningEnd",
  "onReasoningStream",
  "onToolResult",
  "onUserMessagePersisted",
  "replyOperation",
  "shouldEmitToolOutput",
  "shouldEmitToolResult",
];

export class AgentWorkerUnsupportedParamsError extends Error {
  constructor(readonly keys: string[]) {
    super(`Agent worker experiment does not support callback params: ${keys.join(", ")}`);
    this.name = "AgentWorkerUnsupportedParamsError";
  }
}

export type RunEmbeddedPiAgentInWorkerOptions = {
  /** Test seam; production uses the compiled embedded-pi-agent.worker entry. */
  workerUrl?: URL;
  /** Test seam; production inherits the parent process execArgv. */
  execArgv?: string[];
  /** Test seam; production follows OPENCLAW_AGENT_WORKER_PERMISSIONS. */
  usePermissions?: boolean;
};

export function shouldRunEmbeddedPiAgentInWorker(env = process.env): boolean {
  const raw = env.OPENCLAW_AGENT_WORKER_EXPERIMENT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function shouldUseWorkerPermissions(env = process.env): boolean {
  const raw = env.OPENCLAW_AGENT_WORKER_PERMISSIONS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function resolveWorkerUrl(): URL {
  const current = import.meta.url;
  return new URL(
    current.endsWith(".ts") ? "./embedded-pi-agent.worker.ts" : "./embedded-pi-agent.worker.js",
    current,
  );
}

function serializeAbortReason(reason: unknown): unknown {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack };
  }
  return reason;
}

function deserializeWorkerError(message: AgentWorkerToParentMessage & { type: "error" }): Error {
  const error = new Error(message.error.message);
  error.name = message.error.name ?? "AgentWorkerError";
  if (message.error.stack) {
    error.stack = message.error.stack;
  }
  if (message.error.code) {
    (error as Error & { code?: string }).code = message.error.code;
  }
  return error;
}

function stripWorkerCallbacks(params: RunEmbeddedPiAgentParams): EmbeddedPiWorkerRunParams {
  const unsupported = CALLBACK_KEYS.filter((key) => {
    const value = params[key];
    return value !== undefined && !SUPPORTED_CALLBACK_KEYS.has(key);
  });
  if (unsupported.length > 0) {
    throw new AgentWorkerUnsupportedParamsError(unsupported);
  }

  const stripped = { ...params } as Record<string, unknown>;
  for (const key of CALLBACK_KEYS) {
    delete stripped[key];
  }
  return stripped as EmbeddedPiWorkerRunParams;
}

export async function runEmbeddedPiAgentInWorker(
  params: RunEmbeddedPiAgentParams,
  options: RunEmbeddedPiAgentInWorkerOptions = {},
): Promise<EmbeddedPiRunResult> {
  const workerParams = stripWorkerCallbacks(params);
  const worker = new Worker(options.workerUrl ?? resolveWorkerUrl(), {
    execArgv:
      (options.usePermissions ?? shouldUseWorkerPermissions())
        ? [
            ...(options.execArgv ?? process.execArgv),
            ...buildAgentWorkerPermissionExecArgv({
              workspaceDir: params.workspaceDir,
              agentDir: params.agentDir,
              sessionFile: params.sessionFile,
            }),
          ]
        : (options.execArgv ?? process.execArgv),
    name: `openclaw-agent:${params.agentId ?? "main"}:${params.sessionId}`,
  });

  let settled = false;
  const cleanup = () => {
    params.abortSignal?.removeEventListener("abort", abort);
    if (!settled) {
      void worker.terminate();
    }
  };
  const abort = () => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads Worker has no targetOrigin.
    worker.postMessage({ type: "abort", reason: serializeAbortReason(params.abortSignal?.reason) });
  };

  return await new Promise<EmbeddedPiRunResult>((resolve, reject) => {
    worker.once("error", (error) => {
      settled = true;
      cleanup();
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Agent worker exited before completing run (code ${code})`));
    });
    worker.on("message", (message: AgentWorkerToParentMessage) => {
      if (message.type === "agentEvent") {
        void params.onAgentEvent?.(message.event);
        return;
      }
      if (message.type === "executionStarted") {
        params.onExecutionStarted?.();
        return;
      }
      if (message.type === "userMessagePersisted") {
        params.onUserMessagePersisted?.(message.message);
        return;
      }
      if (message.type === "result") {
        settled = true;
        cleanup();
        resolve(message.result);
        void worker.terminate();
        return;
      }
      if (message.type === "error") {
        settled = true;
        cleanup();
        reject(deserializeWorkerError(message));
        void worker.terminate();
      }
    });

    params.abortSignal?.addEventListener("abort", abort, { once: true });
    if (params.abortSignal?.aborted) {
      abort();
    }
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads Worker has no targetOrigin.
      worker.postMessage({ type: "run", params: workerParams });
    } catch (error) {
      settled = true;
      cleanup();
      void worker.terminate();
      reject(error);
    }
  });
}
