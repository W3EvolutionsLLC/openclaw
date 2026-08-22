import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  resolveGatewayStartupRetryAfterMs,
} from "@openclaw/gateway-client/browser";
import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";

export type ChatMetadataResult = CommandsListResult & {
  models?: ModelCatalogEntry[];
};

type ChatMetadataEntry = {
  result?: ChatMetadataResult;
  loadPending?: Promise<ChatMetadataResult>;
  revalidationPending?: Promise<ChatMetadataResult>;
  latestRequest?: Promise<ChatMetadataResult>;
  requestVersion: number;
  resultVersion: number;
  settledVersion: number;
  storeGeneration: number;
  listeners?: Set<(snapshot: ChatMetadataSnapshot) => void>;
};

export type ChatMetadataSnapshot = {
  result?: ChatMetadataResult;
  pending?: Promise<ChatMetadataResult>;
  revalidationPending?: Promise<ChatMetadataResult>;
  requestVersion: number;
  resultVersion: number;
  settledVersion: number;
  storeGeneration: number;
};

const chatMetadataCache = new WeakMap<GatewayBrowserClient, Map<string, ChatMetadataEntry>>();

function chatMetadataAgentKey(agentId: string | null | undefined): string {
  return agentId?.trim() ?? "";
}

function metadataEntryFor(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
): ChatMetadataEntry {
  const key = chatMetadataAgentKey(agentId);
  let cache = chatMetadataCache.get(client);
  if (!cache) {
    cache = new Map();
    chatMetadataCache.set(client, cache);
  }
  let entry = cache.get(key);
  if (!entry) {
    entry = {
      requestVersion: 0,
      resultVersion: 0,
      settledVersion: 0,
      storeGeneration: 0,
    };
    cache.set(key, entry);
  }
  return entry;
}

function chatMetadataSnapshot(entry: ChatMetadataEntry): ChatMetadataSnapshot {
  return {
    result: entry.result,
    pending: entry.requestVersion > entry.settledVersion ? entry.latestRequest : undefined,
    revalidationPending: entry.revalidationPending,
    requestVersion: entry.requestVersion,
    resultVersion: entry.resultVersion,
    settledVersion: entry.settledVersion,
    storeGeneration: entry.storeGeneration,
  };
}

function notifyChatMetadata(entry: ChatMetadataEntry): void {
  const snapshot = chatMetadataSnapshot(entry);
  for (const listener of entry.listeners ?? []) {
    listener(snapshot);
  }
}

function waitForMetadataRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

async function requestChatMetadata(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  opts?: { startupRetryWindowMs?: number },
): Promise<ChatMetadataResult> {
  const params = agentId ? { agentId } : {};
  const retryWindowMs = opts?.startupRetryWindowMs;
  if (retryWindowMs === undefined) {
    return client.request<ChatMetadataResult>("chat.metadata", params);
  }

  const deadlineAt = Date.now() + retryWindowMs;
  let latestStartupError: Error | undefined;

  while (true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw latestStartupError ?? new Error("New-session metadata retry deadline elapsed");
    }

    try {
      return await client.request<ChatMetadataResult>("chat.metadata", params, {
        timeoutMs: Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remainingMs),
      });
    } catch (error) {
      const requestError =
        error instanceof Error
          ? error
          : new Error("New-session metadata request failed", { cause: error });
      const retryAfterMs = resolveGatewayStartupRetryAfterMs(requestError);
      if (retryAfterMs === null) {
        throw requestError;
      }

      const retryRemainingMs = deadlineAt - Date.now();
      if (retryRemainingMs <= 0) {
        throw requestError;
      }

      latestStartupError = requestError;
      await waitForMetadataRetry(Math.min(retryAfterMs, retryRemainingMs));
    }
  }
}

function beginChatMetadataRequest(
  entry: ChatMetadataEntry,
  pendingKey: "loadPending" | "revalidationPending",
  request: Promise<ChatMetadataResult>,
): Promise<ChatMetadataResult> {
  const requestVersion = entry.requestVersion + 1;
  entry.requestVersion = requestVersion;
  const pending = request
    .then((result) => {
      // The newest request owns the snapshot even when an older load settles later.
      if (entry.latestRequest === pending) {
        entry.result = result;
        entry.resultVersion = requestVersion;
        notifyChatMetadata(entry);
      }
      return result;
    })
    .finally(() => {
      if (entry.latestRequest === pending) {
        entry.settledVersion = requestVersion;
      }
      if (entry[pendingKey] === pending) {
        entry[pendingKey] = undefined;
      }
      notifyChatMetadata(entry);
    });
  entry[pendingKey] = pending;
  entry.latestRequest = pending;
  notifyChatMetadata(entry);
  return pending;
}

export function subscribeChatMetadata(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  listener: (snapshot: ChatMetadataSnapshot) => void,
): () => void {
  const entry = metadataEntryFor(client, agentId);
  const listeners = (entry.listeners ??= new Set());
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function peekChatMetadata(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
): ChatMetadataResult | undefined {
  return chatMetadataCache.get(client)?.get(chatMetadataAgentKey(agentId))?.result;
}

export function readChatMetadataSnapshot(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
): ChatMetadataSnapshot {
  return chatMetadataSnapshot(metadataEntryFor(client, agentId));
}

export function loadChatMetadata(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, agentId);
  if (entry.result) {
    return Promise.resolve(entry.result);
  }
  if (entry.loadPending) {
    return entry.loadPending;
  }
  if (entry.revalidationPending) {
    return entry.revalidationPending;
  }

  return beginChatMetadataRequest(entry, "loadPending", requestChatMetadata(client, agentId));
}

export function revalidateChatMetadata(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  opts?: { startupRetryWindowMs?: number },
): Promise<ChatMetadataResult> {
  // Shared revalidation outlives any one caller: consumers drop interest through
  // ownership checks, while completion warms the cache for the next mount.
  const entry = metadataEntryFor(client, agentId);
  if (entry.revalidationPending) {
    return entry.revalidationPending;
  }

  return beginChatMetadataRequest(
    entry,
    "revalidationPending",
    requestChatMetadata(client, agentId, opts),
  );
}

export function rememberChatMetadata(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  result: ChatMetadataResult,
): void {
  const entry = metadataEntryFor(client, agentId);
  const resultVersion = entry.requestVersion + 1;
  entry.requestVersion = resultVersion;
  entry.resultVersion = resultVersion;
  entry.settledVersion = resultVersion;
  entry.result = result;
  entry.loadPending = undefined;
  entry.revalidationPending = undefined;
  entry.latestRequest = undefined;
  notifyChatMetadata(entry);
}

export function invalidateChatMetadataStore(client: GatewayBrowserClient): void {
  for (const entry of chatMetadataCache.get(client)?.values() ?? []) {
    entry.result = undefined;
    entry.loadPending = undefined;
    entry.revalidationPending = undefined;
    entry.latestRequest = undefined;
    entry.requestVersion = 0;
    entry.resultVersion = 0;
    entry.settledVersion = 0;
    entry.storeGeneration += 1;
    notifyChatMetadata(entry);
  }
}
