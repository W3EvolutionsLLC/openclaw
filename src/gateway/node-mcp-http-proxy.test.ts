import { Buffer } from "node:buffer";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  closeMcpLoopbackServer,
  getActiveMcpLoopbackRuntime,
  startMcpLoopbackServer,
} from "./mcp-http.js";
import { resolveMcpLoopbackBearerToken } from "./mcp-http.loopback-runtime.js";
import { NodeMcpClientTransport } from "./node-mcp-client-transport.js";
import { NodeRegistry } from "./node-registry.js";
import type { ConnectParams } from "./protocol/index.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function createNodeClient(params: { nodeId?: string; mcpServers?: unknown[] }): {
  client: GatewayWsClient;
  sent: Array<{ event: string; payload: unknown }>;
} {
  const sent: Array<{ event: string; payload: unknown }> = [];
  const nodeId = params.nodeId ?? "mac-node";
  const connect: ConnectParams = {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "node-host",
      displayName: "Mac",
      version: "dev",
      platform: "macOS",
      mode: "node",
    },
    role: "node",
    scopes: [],
    caps: ["mcpHost"],
    commands: [],
    mcpServers: params.mcpServers as ConnectParams["mcpServers"],
    device: {
      id: nodeId,
      publicKey: "public-key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    },
  };
  const socket = {
    send(data: string) {
      const frame = JSON.parse(data) as { event?: string; payload?: unknown };
      if (frame.event) {
        sent.push({ event: frame.event, payload: frame.payload });
      }
    },
  } as unknown as WebSocket;
  return {
    client: {
      socket,
      connect,
      connId: `${nodeId}-conn`,
      usesSharedGatewayAuth: false,
    },
    sent,
  };
}

function sendNodeMcpRequest(params: {
  port: number;
  token: string;
  nodeId?: string;
  serverId?: string;
  body: unknown;
}) {
  const nodeId = encodeURIComponent(params.nodeId ?? "mac-node");
  const serverId = encodeURIComponent(params.serverId ?? "computer-use");
  return fetch(`http://127.0.0.1:${params.port}/mcp/node/${nodeId}/${serverId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.body),
  });
}

afterEach(async () => {
  await closeMcpLoopbackServer();
});

describe("node MCP loopback proxy", () => {
  it("forwards HTTP MCP JSON-RPC to a node-hosted MCP session", async () => {
    const registry = new NodeRegistry();
    const { client, sent } = createNodeClient({
      mcpServers: [{ id: "computer-use", displayName: "Computer Use", status: "ready" }],
    });
    registry.register(client, {});
    const server = await startMcpLoopbackServer(0, {
      createNodeMcpClientTransport: (options) => new NodeMcpClientTransport(registry, options),
    });
    const runtime = getActiveMcpLoopbackRuntime();
    expect(runtime).toBeTruthy();

    const responsePromise = sendNodeMcpRequest({
      port: server.port,
      token: resolveMcpLoopbackBearerToken(runtime!, true),
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });

    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.event === "node.mcp.session.open")).toBe(true);
    });
    const openPayload = sent.find((entry) => entry.event === "node.mcp.session.open")?.payload as {
      sessionId?: string;
    };
    expect(openPayload.sessionId).toBeTruthy();
    registry.handleMcpSessionOpenResult({
      sessionId: openPayload.sessionId!,
      nodeId: "mac-node",
      serverId: "computer-use",
      ok: true,
      pid: 42,
    });

    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.event === "node.mcp.session.input")).toBe(true);
    });
    const inputPayload = sent.find((entry) => entry.event === "node.mcp.session.input")
      ?.payload as {
      dataBase64?: string;
      seq?: number;
    };
    expect(Buffer.from(inputPayload.dataBase64 ?? "", "base64").toString("utf8")).toBe(
      serializeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );

    registry.handleMcpSessionOutput({
      sessionId: openPayload.sessionId!,
      nodeId: "mac-node",
      seq: inputPayload.seq ?? 0,
      stream: "stdout",
      dataBase64: Buffer.from(
        serializeMessage({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "mock-computer-use", version: "1" },
          },
        }),
      ).toString("base64"),
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: { name: "mock-computer-use" },
      },
    });
  });

  it("requires the owner loopback token for node-hosted MCP servers", async () => {
    const server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    expect(runtime).toBeTruthy();

    const response = await sendNodeMcpRequest({
      port: server.port,
      token: resolveMcpLoopbackBearerToken(runtime!, false),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Owner token required" },
    });
  });
});
