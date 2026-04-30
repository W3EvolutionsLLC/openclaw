export const NODE_MCP_SERVER_STATUSES = [
  "ready",
  "disabled",
  "missing_permissions",
  "missing_backend",
  "unsupported",
  "error",
] as const;

export type NodeMcpServerStatus = (typeof NODE_MCP_SERVER_STATUSES)[number];

export type NodeMcpServerDescriptor = {
  id: string;
  displayName?: string;
  provider?: string;
  transport?: "stdio";
  source?: string;
  status?: NodeMcpServerStatus;
  requiredPermissions?: string[];
  metadata?: Record<string, unknown>;
};

export function isNodeMcpServerOpenable(descriptor: NodeMcpServerDescriptor): boolean {
  return (
    !descriptor.status ||
    descriptor.status === "ready" ||
    descriptor.status === "missing_permissions"
  );
}

function nonEmptyTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = new Set<string>();
  for (const item of value) {
    const trimmed = nonEmptyTrimmedString(item);
    if (trimmed) {
      values.add(trimmed);
    }
  }
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function isNodeMcpServerStatus(value: unknown): value is NodeMcpServerStatus {
  return (
    typeof value === "string" && (NODE_MCP_SERVER_STATUSES as readonly string[]).includes(value)
  );
}

export function normalizeNodeMcpServerDescriptors(
  value: unknown,
): NodeMcpServerDescriptor[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const descriptors: NodeMcpServerDescriptor[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const id = nonEmptyTrimmedString(raw.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const displayName = nonEmptyTrimmedString(raw.displayName);
    const provider = nonEmptyTrimmedString(raw.provider);
    const source = nonEmptyTrimmedString(raw.source);
    const requiredPermissions = normalizeStringList(raw.requiredPermissions);
    const transport = raw.transport === "stdio" ? "stdio" : undefined;
    const status = isNodeMcpServerStatus(raw.status) ? raw.status : undefined;
    const metadata =
      raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? (raw.metadata as Record<string, unknown>)
        : undefined;
    descriptors.push({
      id,
      ...(displayName ? { displayName } : {}),
      ...(provider ? { provider } : {}),
      ...(transport ? { transport } : {}),
      ...(source ? { source } : {}),
      ...(status ? { status } : {}),
      ...(requiredPermissions ? { requiredPermissions } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }
  return descriptors.length > 0 ? descriptors : undefined;
}

export function normalizeNodeMcpServerIds(value: unknown): string[] {
  return (normalizeNodeMcpServerDescriptors(value) ?? []).map((descriptor) => descriptor.id);
}
