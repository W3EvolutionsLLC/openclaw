import type { Agent } from "node:https";
import { createRequire } from "node:module";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  readPluginPackageVersion,
  resolveAmbientNodeProxyAgent,
} from "openclaw/plugin-sdk/extension-shared";
import type { FeishuConfig, FeishuDomain, ResolvedFeishuAccount } from "./types.js";

const require = createRequire(import.meta.url);
const pluginVersion = readPluginPackageVersion({ require });

export { pluginVersion };

const FEISHU_USER_AGENT = `openclaw-feishu-builtin/${pluginVersion}/${process.platform}`;
export { FEISHU_USER_AGENT };

export const FEISHU_WS_START_TIMEOUT_MS = 30_000;

const FEISHU_WS_RECONNECT_REQUIRED = Symbol("feishu-ws-reconnect-required");
const FEISHU_WS_CLIENT_CLOSED = Symbol("feishu-ws-client-closed");

export class FeishuWebSocketReconnectRequiredError extends Error {
  readonly [FEISHU_WS_RECONNECT_REQUIRED] = true;

  constructor() {
    super("Feishu WebSocket disconnected; reconnecting through OpenClaw monitor backoff");
    this.name = "FeishuWebSocketReconnectRequiredError";
  }
}

export class FeishuWebSocketClientClosedError extends Error {
  readonly [FEISHU_WS_CLIENT_CLOSED] = true;

  constructor() {
    super("Feishu WebSocket client closed");
    this.name = "FeishuWebSocketClientClosedError";
  }
}

export function isFeishuWebSocketReconnectRequiredError(
  err: unknown,
): err is FeishuWebSocketReconnectRequiredError {
  return !!err && typeof err === "object" && FEISHU_WS_RECONNECT_REQUIRED in err;
}

export function isFeishuWebSocketClientClosedError(
  err: unknown,
): err is FeishuWebSocketClientClosedError {
  return !!err && typeof err === "object" && FEISHU_WS_CLIENT_CLOSED in err;
}

export type FeishuWebSocketClient = {
  start(params: Parameters<Lark.WSClient["start"]>[0]): Promise<void>;
  close(params?: Parameters<Lark.WSClient["close"]>[0]): void;
  getReconnectInfo(): ReturnType<Lark.WSClient["getReconnectInfo"]>;
  waitForTerminalError(): Promise<Error>;
};

/** User-Agent header value for all Feishu API requests. */
export function getFeishuUserAgent(): string {
  return FEISHU_USER_AGENT;
}

type FeishuClientSdk = Pick<
  typeof Lark,
  | "AppType"
  | "Client"
  | "defaultHttpInstance"
  | "Domain"
  | "EventDispatcher"
  | "LoggerLevel"
  | "WSClient"
>;

const defaultFeishuClientSdk: FeishuClientSdk = {
  AppType: Lark.AppType,
  Client: Lark.Client,
  defaultHttpInstance: Lark.defaultHttpInstance,
  Domain: Lark.Domain,
  EventDispatcher: Lark.EventDispatcher,
  LoggerLevel: Lark.LoggerLevel,
  WSClient: Lark.WSClient,
};

let feishuClientSdk: FeishuClientSdk = defaultFeishuClientSdk;

// Override the SDK's default User-Agent interceptor.
// The Lark SDK registers an axios request interceptor that sets
// 'oapi-node-sdk/1.0.0'. Axios request interceptors execute in LIFO order
// (last-registered runs first), so simply appending ours doesn't work — the
// SDK's interceptor would run last and overwrite our UA. We must clear
// handlers[] first, then register our own as the sole interceptor.
//
// Risk is low: the SDK only registers one interceptor (UA) at init time, and
// we clear it at module load before any other code can register handlers.
// If a future SDK version adds more interceptors, the upgrade will need
// compatibility verification regardless.
{
  const inst = Lark.defaultHttpInstance as {
    interceptors?: {
      request: { handlers: unknown[]; use: (fn: (req: unknown) => unknown) => void };
    };
  };
  if (inst.interceptors?.request) {
    inst.interceptors.request.handlers = [];
    inst.interceptors.request.use((req: unknown) => {
      const r = req as { headers?: Record<string, string> };
      if (r.headers) {
        r.headers["User-Agent"] = getFeishuUserAgent();
      }
      return req;
    });
  }
}

/** Default HTTP timeout for Feishu API requests (30 seconds). */
export const FEISHU_HTTP_TIMEOUT_MS = 30_000;
export const FEISHU_HTTP_TIMEOUT_MAX_MS = 300_000;
export const FEISHU_HTTP_TIMEOUT_ENV_VAR = "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS";

type FeishuHttpInstanceLike = Pick<
  typeof feishuClientSdk.defaultHttpInstance,
  "request" | "get" | "post" | "put" | "patch" | "delete" | "head" | "options"
>;

async function getWsProxyAgent() {
  return resolveAmbientNodeProxyAgent<Agent>();
}

type FeishuWsPrivateControlHooks = {
  handleControlData?: (data: unknown) => unknown;
};

type PendingWsStart = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ManagedFeishuWebSocketClient = FeishuWebSocketClient & {
  handleReady(): void;
  handleError(err: unknown): void;
  handleReconnecting(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isFeishuWsPongWithoutPingInterval(data: unknown): boolean {
  if (!isRecord(data) || !Array.isArray(data.headers)) {
    return false;
  }

  const isPong = data.headers.some((header) => {
    if (!isRecord(header)) {
      return false;
    }
    return header.key === "type" && header.value === "pong";
  });
  if (!isPong || !(data.payload instanceof Uint8Array)) {
    return false;
  }

  try {
    const parsed = JSON.parse(new TextDecoder("utf-8").decode(data.payload)) as unknown;
    return isRecord(parsed) && !("PingInterval" in parsed);
  } catch {
    return false;
  }
}

function isFeishuWsPingIntervalError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.message.includes("PingInterval");
}

function installFeishuWsPingIntervalGuard(rawClient: Lark.WSClient): void {
  const hooks = rawClient as unknown as FeishuWsPrivateControlHooks;
  const handleControlData = hooks.handleControlData;
  if (typeof handleControlData !== "function") {
    return;
  }

  hooks.handleControlData = async function guardedHandleControlData(this: unknown, data: unknown) {
    if (isFeishuWsPongWithoutPingInterval(data)) {
      return;
    }
    try {
      await handleControlData.call(this, data);
    } catch (err) {
      if (isFeishuWsPingIntervalError(err)) {
        return;
      }
      throw err;
    }
  };
}

function normalizeWsError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function createManagedFeishuWSClient(rawClient: Lark.WSClient): ManagedFeishuWebSocketClient {
  installFeishuWsPingIntervalGuard(rawClient);

  let closed = false;
  let pendingStart: PendingWsStart | undefined;
  let terminalSettled = false;
  let resolveTerminalError!: (err: Error) => void;
  const terminalErrorPromise = new Promise<Error>((resolve) => {
    resolveTerminalError = resolve;
  });

  const signalTerminalError = (err: Error) => {
    if (terminalSettled) {
      return;
    }
    terminalSettled = true;
    resolveTerminalError(err);
  };

  const settleStart = (settle: "resolve" | "reject", err?: Error) => {
    const pending = pendingStart;
    if (!pending) {
      return;
    }
    pendingStart = undefined;
    clearTimeout(pending.timer);
    if (settle === "resolve") {
      pending.resolve();
    } else {
      pending.reject(err ?? new Error("Feishu WebSocket start failed"));
    }
  };

  const closeRawClient = (params?: Parameters<Lark.WSClient["close"]>[0]) => {
    rawClient.close(params);
  };

  let reconnectCloseScheduled = false;
  const scheduleReconnectClose = () => {
    if (reconnectCloseScheduled) {
      return;
    }
    reconnectCloseScheduled = true;
    queueMicrotask(() => {
      reconnectCloseScheduled = false;
      try {
        closeRawClient({ force: true });
      } catch {
        /* Best-effort cleanup after SDK reconnect handoff */
      }
    });
  };

  return {
    start(params) {
      if (closed) {
        return Promise.reject(new FeishuWebSocketClientClosedError());
      }
      if (pendingStart) {
        return Promise.reject(new Error("Feishu WebSocket client start already in progress"));
      }

      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const err = new Error(
            `Feishu WebSocket start timed out after ${FEISHU_WS_START_TIMEOUT_MS}ms`,
          );
          settleStart("reject", err);
          try {
            closeRawClient({ force: true });
          } catch {
            /* Best-effort cleanup after startup timeout */
          }
        }, FEISHU_WS_START_TIMEOUT_MS);
        timer.unref?.();
        pendingStart = { resolve, reject, timer };
        try {
          rawClient.start(params).catch((err: unknown) => {
            settleStart("reject", normalizeWsError(err));
          });
        } catch (err) {
          settleStart("reject", normalizeWsError(err));
        }
      });
    },
    close(params) {
      closed = true;
      const err = new FeishuWebSocketClientClosedError();
      settleStart("reject", err);
      signalTerminalError(err);
      closeRawClient(params);
    },
    getReconnectInfo() {
      return rawClient.getReconnectInfo();
    },
    waitForTerminalError() {
      return terminalErrorPromise;
    },
    handleReady() {
      settleStart("resolve");
    },
    handleError(err) {
      const normalized = normalizeWsError(err);
      settleStart("reject", normalized);
      signalTerminalError(normalized);
    },
    handleReconnecting() {
      signalTerminalError(new FeishuWebSocketReconnectRequiredError());
      scheduleReconnectClose();
    },
  };
}

// Multi-account client cache
const clientCache = new Map<
  string,
  {
    client: Lark.Client;
    config: { appId: string; appSecret: string; domain?: FeishuDomain; httpTimeoutMs: number };
  }
>();

function resolveDomain(domain: FeishuDomain | undefined): Lark.Domain | string {
  if (domain === "lark") {
    return feishuClientSdk.Domain.Lark;
  }
  if (domain === "feishu" || !domain) {
    return feishuClientSdk.Domain.Feishu;
  }
  return domain.replace(/\/+$/, ""); // Custom URL for private deployment
}

/**
 * Create an HTTP instance that delegates to the Lark SDK's default instance
 * but injects a default request timeout and User-Agent header to prevent
 * indefinite hangs and set a standardized User-Agent per OAPI best practices.
 */
function createTimeoutHttpInstance(defaultTimeoutMs: number): Lark.HttpInstance {
  const base: FeishuHttpInstanceLike = feishuClientSdk.defaultHttpInstance;

  function injectTimeout<D>(opts?: Lark.HttpRequestOptions<D>): Lark.HttpRequestOptions<D> {
    return { timeout: defaultTimeoutMs, ...opts } as Lark.HttpRequestOptions<D>;
  }

  return {
    request: (opts) => base.request(injectTimeout(opts)),
    get: (url, opts) => base.get(url, injectTimeout(opts)),
    post: (url, data, opts) => base.post(url, data, injectTimeout(opts)),
    put: (url, data, opts) => base.put(url, data, injectTimeout(opts)),
    patch: (url, data, opts) => base.patch(url, data, injectTimeout(opts)),
    delete: (url, opts) => base.delete(url, injectTimeout(opts)),
    head: (url, opts) => base.head(url, injectTimeout(opts)),
    options: (url, opts) => base.options(url, injectTimeout(opts)),
  };
}

/**
 * Credentials needed to create a Feishu client.
 * Both FeishuConfig and ResolvedFeishuAccount satisfy this interface.
 */
export type FeishuClientCredentials = {
  accountId?: string;
  appId?: string;
  appSecret?: string;
  domain?: FeishuDomain;
  httpTimeoutMs?: number;
  config?: Pick<FeishuConfig, "httpTimeoutMs">;
};

function resolveConfiguredHttpTimeoutMs(creds: FeishuClientCredentials): number {
  const clampTimeout = (value: number): number => {
    const rounded = Math.floor(value);
    return Math.min(Math.max(rounded, 1), FEISHU_HTTP_TIMEOUT_MAX_MS);
  };

  const fromDirectField = creds.httpTimeoutMs;
  if (
    typeof fromDirectField === "number" &&
    Number.isFinite(fromDirectField) &&
    fromDirectField > 0
  ) {
    return clampTimeout(fromDirectField);
  }

  const envRaw = process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  if (envRaw) {
    const envValue = Number(envRaw);
    if (Number.isFinite(envValue) && envValue > 0) {
      return clampTimeout(envValue);
    }
  }

  const fromConfig = creds.config?.httpTimeoutMs;
  const timeout = fromConfig;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return FEISHU_HTTP_TIMEOUT_MS;
  }
  return clampTimeout(timeout);
}

/**
 * Create or get a cached Feishu client for an account.
 * Accepts any object with appId, appSecret, and optional domain/accountId.
 */
export function createFeishuClient(creds: FeishuClientCredentials): Lark.Client {
  const { accountId = "default", appId, appSecret, domain } = creds;
  const defaultHttpTimeoutMs = resolveConfiguredHttpTimeoutMs(creds);

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  // Check cache
  const cached = clientCache.get(accountId);
  if (
    cached &&
    cached.config.appId === appId &&
    cached.config.appSecret === appSecret &&
    cached.config.domain === domain &&
    cached.config.httpTimeoutMs === defaultHttpTimeoutMs
  ) {
    return cached.client;
  }

  // Create new client with timeout-aware HTTP instance
  const client = new feishuClientSdk.Client({
    appId,
    appSecret,
    appType: feishuClientSdk.AppType.SelfBuild,
    domain: resolveDomain(domain),
    httpInstance: createTimeoutHttpInstance(defaultHttpTimeoutMs),
  });

  // Cache it
  clientCache.set(accountId, {
    client,
    config: { appId, appSecret, domain, httpTimeoutMs: defaultHttpTimeoutMs },
  });

  return client;
}

/**
 * Create a Feishu WebSocket client for an account.
 * Note: WSClient is not cached since each call creates a new connection.
 */
export async function createFeishuWSClient(
  account: ResolvedFeishuAccount,
): Promise<FeishuWebSocketClient> {
  const { accountId, appId, appSecret, domain } = account;

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  const agent = await getWsProxyAgent();
  let managedClient: ManagedFeishuWebSocketClient | undefined;
  const rawClient = new feishuClientSdk.WSClient({
    appId,
    appSecret,
    domain: resolveDomain(domain),
    loggerLevel: feishuClientSdk.LoggerLevel.info,
    autoReconnect: true,
    onReady: () => {
      managedClient?.handleReady();
    },
    onError: (err) => {
      managedClient?.handleError(err);
    },
    onReconnecting: () => {
      managedClient?.handleReconnecting();
    },
    ...(agent ? { agent } : {}),
  });
  managedClient = createManagedFeishuWSClient(rawClient);
  return managedClient;
}

/**
 * Create an event dispatcher for an account.
 */
export function createEventDispatcher(account: ResolvedFeishuAccount): Lark.EventDispatcher {
  return new feishuClientSdk.EventDispatcher({
    encryptKey: account.encryptKey,
    verificationToken: account.verificationToken,
  });
}

/**
 * Get a cached client for an account (if exists).
 */
export function getFeishuClient(accountId: string): Lark.Client | null {
  return clientCache.get(accountId)?.client ?? null;
}

/**
 * Clear client cache for a specific account or all accounts.
 */
export function clearClientCache(accountId?: string): void {
  if (accountId) {
    clientCache.delete(accountId);
  } else {
    clientCache.clear();
  }
}

export function setFeishuClientRuntimeForTest(overrides?: {
  sdk?: Partial<FeishuClientSdk>;
}): void {
  feishuClientSdk = overrides?.sdk
    ? { ...defaultFeishuClientSdk, ...overrides.sdk }
    : defaultFeishuClientSdk;
}
