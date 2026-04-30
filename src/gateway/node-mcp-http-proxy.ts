import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { jsonRpcError, type JsonRpcRequest } from "./mcp-http.protocol.js";
import type { NodeMcpClientTransportOptions } from "./node-mcp-client-transport.js";

const NODE_MCP_LOOPBACK_PREFIX = "/mcp/node/";
const NODE_MCP_HTTP_TIMEOUT_MS = 60_000;

export type NodeMcpTransportFactory = (options: NodeMcpClientTransportOptions) => Transport;

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: unknown;
};

type PendingResponse = {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
};

type NodeMcpLoopbackTarget = {
  nodeId: string;
  serverId: string;
};

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function messageHasId(message: JsonRpcRequest): message is JsonRpcRequest & {
  id: string | number;
} {
  return typeof message.id === "string" || typeof message.id === "number";
}

function normalizeJsonRpcResponse(message: JSONRPCMessage): JsonRpcResponse | null {
  if (!message || typeof message !== "object" || !hasOwn(message, "id")) {
    return null;
  }
  const raw = message as Record<string, unknown>;
  if (typeof raw.id !== "string" && typeof raw.id !== "number") {
    return null;
  }
  if (!hasOwn(raw, "result") && !hasOwn(raw, "error")) {
    return null;
  }
  return {
    jsonrpc: "2.0",
    id: raw.id,
    ...(hasOwn(raw, "result") ? { result: raw.result } : {}),
    ...(hasOwn(raw, "error") ? { error: raw.error } : {}),
  };
}

function responseKey(id: string | number): string {
  return JSON.stringify(id);
}

function parseNodeMcpLoopbackPath(pathname: string): NodeMcpLoopbackTarget | null {
  if (!pathname.startsWith(NODE_MCP_LOOPBACK_PREFIX)) {
    return null;
  }
  const suffix = pathname.slice(NODE_MCP_LOOPBACK_PREFIX.length);
  const parts = suffix.split("/");
  if (parts.length !== 2) {
    return null;
  }
  const [rawNodeId, rawServerId] = parts;
  if (!rawNodeId || !rawServerId) {
    return null;
  }
  try {
    return {
      nodeId: decodeURIComponent(rawNodeId),
      serverId: decodeURIComponent(rawServerId),
    };
  } catch {
    return null;
  }
}

export function isNodeMcpLoopbackPath(pathname: string): boolean {
  return pathname.startsWith(NODE_MCP_LOOPBACK_PREFIX);
}

class NodeMcpProxySession {
  private transport: Transport | undefined;
  private startPromise: Promise<void> | undefined;
  private pending = new Map<string, PendingResponse>();
  private closed = false;

  constructor(
    private readonly target: NodeMcpLoopbackTarget,
    private readonly createTransport: NodeMcpTransportFactory,
    private readonly onClosed: () => void,
  ) {}

  async forward(
    messages: JsonRpcRequest[],
    signal?: AbortSignal,
  ): Promise<Array<JsonRpcResponse | ReturnType<typeof jsonRpcError>>> {
    try {
      await this.ensureStarted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const responses = messages
        .filter(messageHasId)
        .map((request) => jsonRpcError(request.id, -32000, message));
      return responses.length > 0 ? responses : [jsonRpcError(null, -32000, message)];
    }

    let waiters: Array<{
      id: string | number;
      promise: Promise<JsonRpcResponse>;
    }> = [];
    const immediateResponses: Array<ReturnType<typeof jsonRpcError>> = [];
    for (const message of messages) {
      const responseId = messageHasId(message) ? message.id : undefined;
      const pendingKey = responseId !== undefined ? responseKey(responseId) : undefined;
      let waiter: Promise<JsonRpcResponse> | undefined;
      if (responseId !== undefined && pendingKey) {
        waiter = this.waitForResponse(responseId, signal);
        waiters.push({ id: responseId, promise: waiter });
      }
      try {
        await this.transport?.send(message as JSONRPCMessage);
      } catch (error) {
        if (responseId !== undefined && pendingKey) {
          this.rejectPending(pendingKey, error);
          waiters = waiters.filter((entry) => responseKey(entry.id) !== pendingKey);
          immediateResponses.push(
            jsonRpcError(
              responseId,
              -32000,
              error instanceof Error ? error.message : String(error),
            ),
          );
        } else {
          throw error;
        }
      }
    }

    if (waiters.length === 0) {
      return immediateResponses;
    }
    const settled = await Promise.allSettled(waiters.map((entry) => entry.promise));
    return [
      ...immediateResponses,
      ...settled.map((result, index) =>
        result.status === "fulfilled"
          ? result.value
          : jsonRpcError(
              waiters[index]?.id ?? null,
              -32000,
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            ),
      ),
    ];
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAll(new Error("node MCP loopback proxy closed"));
    await this.transport?.close?.();
    this.transport = undefined;
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) {
      throw new Error("node MCP loopback proxy is closed");
    }
    if (this.transport) {
      await this.startPromise;
      return;
    }
    const transport = this.createTransport({
      nodeId: this.target.nodeId,
      serverId: this.target.serverId,
      openTimeoutMs: 30_000,
    });
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
    transport.onmessage = (message) => this.handleMessage(message);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
    transport.onerror = (error) => this.handleTransportClosed(error);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
    transport.onclose = () => this.handleTransportClosed();
    this.transport = transport;
    this.startPromise = transport.start().catch((error) => {
      this.transport = undefined;
      this.startPromise = undefined;
      throw error;
    });
    await this.startPromise;
  }

  private waitForResponse(id: string | number, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const key = responseKey(id);
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`duplicate pending JSON-RPC id ${key}`));
    }
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const cleanup = () => {
        const entry = this.pending.get(key);
        if (entry?.abortListener && signal) {
          signal.removeEventListener("abort", entry.abortListener);
        }
        if (entry) {
          clearTimeout(entry.timer);
        }
        this.pending.delete(key);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("node MCP HTTP request timed out"));
      }, NODE_MCP_HTTP_TIMEOUT_MS);
      const abortListener = signal
        ? () => {
            cleanup();
            reject(new Error("node MCP HTTP request aborted"));
          }
        : undefined;
      if (abortListener) {
        signal?.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(key, {
        resolve: (response) => {
          cleanup();
          resolve(response);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
        abortListener,
      });
    });
  }

  private handleMessage(message: JSONRPCMessage): void {
    const response = normalizeJsonRpcResponse(message);
    if (!response) {
      return;
    }
    const pending = this.pending.get(responseKey(response.id));
    if (!pending) {
      return;
    }
    pending.resolve(response);
  }

  private rejectPending(key: string, error: unknown): void {
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private rejectAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private handleTransportClosed(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectAll(error ?? new Error("node MCP session closed"));
    this.onClosed();
  }
}

export class NodeMcpHttpProxyManager {
  private sessions = new Map<string, NodeMcpProxySession>();

  constructor(private readonly getTransportFactory: () => NodeMcpTransportFactory | undefined) {}

  async handle(params: {
    pathname: string;
    messages: JsonRpcRequest[];
    signal?: AbortSignal;
  }): Promise<Array<JsonRpcResponse | ReturnType<typeof jsonRpcError>>> {
    const target = parseNodeMcpLoopbackPath(params.pathname);
    if (!target) {
      return [jsonRpcError(null, -32602, "Invalid node MCP loopback path")];
    }
    const factory = this.getTransportFactory();
    if (!factory) {
      return [jsonRpcError(null, -32000, "Node MCP loopback proxy is unavailable")];
    }
    const key = `${target.nodeId}\0${target.serverId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = new NodeMcpProxySession(target, factory, () => {
        this.sessions.delete(key);
      });
      this.sessions.set(key, session);
    }
    return await session.forward(params.messages, params.signal);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }
}
