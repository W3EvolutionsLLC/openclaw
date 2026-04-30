import type { AgentThreadMcpServers } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { JsonObject } from "./protocol.js";

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildCodexThreadMcpConfig(
  servers: AgentThreadMcpServers | undefined,
): JsonObject | undefined {
  if (!servers || Object.keys(servers).length === 0) {
    return undefined;
  }

  const codexServers: JsonObject = {};
  for (const [id, server] of Object.entries(servers).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (server.transport !== "http") {
      continue;
    }
    const entry: JsonObject = {
      url: server.url,
    };
    if (server.headers && Object.keys(server.headers).length > 0) {
      entry.http_headers = server.headers;
    }
    if (server.startupTimeoutSec !== undefined) {
      entry.startup_timeout_sec = server.startupTimeoutSec;
    }
    if (server.toolTimeoutSec !== undefined) {
      entry.tool_timeout_sec = server.toolTimeoutSec;
    }
    if (server.defaultToolsApprovalMode !== undefined) {
      entry.default_tools_approval_mode = server.defaultToolsApprovalMode;
    }
    codexServers[id] = entry;
  }

  if (Object.keys(codexServers).length === 0) {
    return undefined;
  }
  return { mcp_servers: codexServers };
}

export function mergeCodexThreadConfigs(
  ...configs: Array<JsonObject | undefined>
): JsonObject | undefined {
  const merged: JsonObject = {};
  for (const config of configs) {
    if (!config) {
      continue;
    }
    const existingMcpServers = isJsonObject(merged.mcp_servers) ? merged.mcp_servers : undefined;
    const nextMcpServers = isJsonObject(config.mcp_servers) ? config.mcp_servers : undefined;
    Object.assign(merged, config);
    if (existingMcpServers || nextMcpServers) {
      merged.mcp_servers = {
        ...existingMcpServers,
        ...nextMcpServers,
      };
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
