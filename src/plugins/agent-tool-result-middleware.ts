import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareOptions,
  AgentToolResultMiddlewareRuntime,
} from "./agent-tool-result-middleware-types.js";
import type {
  PluginAgentToolResultMiddlewareRegistration,
  PluginRegistry,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";

export const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES = [
  "openclaw",
  "codex",
] as const satisfies AgentToolResultMiddlewareRuntime[];

const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIME_SET = new Set<string>(
  AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES,
);

const LEGACY_AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES = {
  "codex-app-server": "codex",
} as const satisfies Record<string, AgentToolResultMiddlewareRuntime>;

function normalizeAgentToolResultMiddlewareRuntime(
  runtime: string,
): AgentToolResultMiddlewareRuntime | undefined {
  const normalized = runtime.trim().toLowerCase();
  const legacyRuntime =
    LEGACY_AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES[
      normalized as keyof typeof LEGACY_AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES
    ];
  if (legacyRuntime) {
    return legacyRuntime;
  }
  return AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIME_SET.has(normalized)
    ? (normalized as AgentToolResultMiddlewareRuntime)
    : undefined;
}

function copyRequestedAgentToolResultMiddlewareRuntimes(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return Array.isArray(value)
      ? Array.from(value).filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function normalizeAgentToolResultMiddlewareRuntimes(
  options?: AgentToolResultMiddlewareOptions,
): AgentToolResultMiddlewareRuntime[] {
  let requested: string[] | undefined;
  try {
    requested =
      copyRequestedAgentToolResultMiddlewareRuntimes(options?.runtimes) ??
      copyRequestedAgentToolResultMiddlewareRuntimes(options?.harnesses);
  } catch {
    return [];
  }
  if (!requested) {
    return [...AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES];
  }
  const normalized: AgentToolResultMiddlewareRuntime[] = [];
  for (const runtime of requested) {
    const value = normalizeAgentToolResultMiddlewareRuntime(runtime);
    if (!value) {
      continue;
    }
    if (!normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

/** @deprecated Use normalizeAgentToolResultMiddlewareRuntimes. */
export const normalizeAgentToolResultMiddlewareHarnesses =
  normalizeAgentToolResultMiddlewareRuntimes;

export function normalizeAgentToolResultMiddlewareRuntimeIds(
  runtimes: readonly string[] | undefined,
): AgentToolResultMiddlewareRuntime[] {
  const normalized: AgentToolResultMiddlewareRuntime[] = [];
  for (const runtime of runtimes ?? []) {
    const value = normalizeAgentToolResultMiddlewareRuntime(runtime);
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

function copyAgentToolResultMiddlewareEntries(
  entries: unknown,
): PluginAgentToolResultMiddlewareRegistration[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  let length = 0;
  try {
    length = entries.length;
  } catch {
    return [];
  }
  const copied: PluginAgentToolResultMiddlewareRegistration[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      copied.push(entries[index]);
    } catch {
      // Skip unreadable middleware entries; later registrations can still handle results.
    }
  }
  return copied;
}

function entryTargetsAgentToolResultRuntime(
  entry: PluginAgentToolResultMiddlewareRegistration,
  runtime: AgentToolResultMiddlewareRuntime,
): boolean {
  try {
    const runtimes = entry.runtimes;
    if (!Array.isArray(runtimes)) {
      return false;
    }
    for (const candidate of runtimes) {
      if (candidate === runtime) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function readAgentToolResultMiddlewareHandler(
  entry: PluginAgentToolResultMiddlewareRegistration,
): AgentToolResultMiddleware | null {
  try {
    return typeof entry.handler === "function" ? entry.handler : null;
  } catch {
    return null;
  }
}

export function listAgentToolResultMiddlewaresFromRegistry(
  registry: PluginRegistry | null | undefined,
  runtime: AgentToolResultMiddlewareRuntime,
): AgentToolResultMiddleware[] {
  const entries = copyAgentToolResultMiddlewareEntries(registry?.agentToolResultMiddlewares);
  return entries.flatMap((entry) => {
    if (!entryTargetsAgentToolResultRuntime(entry, runtime)) {
      return [];
    }
    const handler = readAgentToolResultMiddlewareHandler(entry);
    return handler ? [handler] : [];
  });
}

export function listAgentToolResultMiddlewares(
  runtime: AgentToolResultMiddlewareRuntime,
): AgentToolResultMiddleware[] {
  return listAgentToolResultMiddlewaresFromRegistry(getActivePluginRegistry(), runtime);
}
