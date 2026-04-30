import type { NodeMcpServerDescriptor } from "./node-mcp-types.js";

export type NodeListNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  clientId?: string;
  clientMode?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  pathEnv?: string;
  caps?: string[];
  commands?: string[];
  mcpServers?: NodeMcpServerDescriptor[];
  permissions?: Record<string, boolean>;
  paired?: boolean;
  connected?: boolean;
  connectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
  approvedAtMs?: number;
};

export type PendingRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  ts: number;
  commands?: string[];
  mcpServers?: NodeMcpServerDescriptor[];
  requiredApproveScopes?: Array<"operator.pairing" | "operator.write" | "operator.admin">;
};

export type PairedNode = {
  nodeId: string;
  token?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  permissions?: Record<string, boolean>;
  mcpServers?: NodeMcpServerDescriptor[];
  createdAtMs?: number;
  approvedAtMs?: number;
  lastConnectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

export type PairingList = {
  pending: PendingRequest[];
  paired: PairedNode[];
};
