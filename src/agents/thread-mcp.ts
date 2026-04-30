export type AgentThreadMcpHttpServer = {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  defaultToolsApprovalMode?: "approve" | "auto";
};

export type AgentThreadMcpServers = Record<string, AgentThreadMcpHttpServer>;
