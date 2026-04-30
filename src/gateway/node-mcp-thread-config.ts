import type { AgentThreadMcpServers } from "../agents/thread-mcp.js";
import { isNodeMcpServerOpenable } from "../shared/node-mcp-types.js";
import {
  ensureMcpLoopbackServer,
  getActiveMcpLoopbackRuntime,
  resolveMcpLoopbackBearerToken,
} from "./mcp-http.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

const COMPUTER_USE_MCP_SERVER_ID = "computer-use";

function compareOptionalLabel(left: string | undefined, right: string | undefined): number {
  return (left ?? "").localeCompare(right ?? "");
}

export async function resolveNodeHostedThreadMcpServers(params: {
  context: Pick<GatewayRequestContext, "createNodeMcpClientTransport" | "nodeRegistry">;
  senderIsOwner: boolean;
}): Promise<AgentThreadMcpServers | undefined> {
  if (!params.senderIsOwner) {
    return undefined;
  }

  const candidates = params.context.nodeRegistry
    .listConnected()
    .filter((node) => node.caps.includes("mcpHost"))
    .toSorted((left, right) => {
      const labelDelta = compareOptionalLabel(left.displayName, right.displayName);
      return labelDelta !== 0 ? labelDelta : left.nodeId.localeCompare(right.nodeId);
    });

  for (const node of candidates) {
    const descriptor = (node.mcpServers ?? [])
      .filter((entry) => entry.id === COMPUTER_USE_MCP_SERVER_ID)
      .find((entry) => isNodeMcpServerOpenable(entry));
    if (!descriptor) {
      continue;
    }

    const server = await ensureMcpLoopbackServer(0, {
      createNodeMcpClientTransport: params.context.createNodeMcpClientTransport,
    });
    const runtime = getActiveMcpLoopbackRuntime();
    if (!runtime) {
      return undefined;
    }
    const nodeId = encodeURIComponent(node.nodeId);
    const serverId = encodeURIComponent(descriptor.id);
    return {
      [COMPUTER_USE_MCP_SERVER_ID]: {
        transport: "http",
        url: `http://127.0.0.1:${server.port}/mcp/node/${nodeId}/${serverId}`,
        headers: {
          Authorization: `Bearer ${resolveMcpLoopbackBearerToken(runtime, true)}`,
        },
        startupTimeoutSec: 30,
        toolTimeoutSec: 120,
        defaultToolsApprovalMode: "approve",
      },
    };
  }

  return undefined;
}
