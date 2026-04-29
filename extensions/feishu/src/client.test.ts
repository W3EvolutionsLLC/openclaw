import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import type { ResolvedFeishuAccount } from "./types.js";

type CreateFeishuClient = typeof import("./client.js").createFeishuClient;
type CreateFeishuWSClient = typeof import("./client.js").createFeishuWSClient;
type ClearClientCache = typeof import("./client.js").clearClientCache;
type SetFeishuClientRuntimeForTest = typeof import("./client.js").setFeishuClientRuntimeForTest;

type AsyncControlHandler = (data: unknown) => Promise<void>;

type MockRawWsClient = {
  start: Mock<(params: unknown) => Promise<void>>;
  close: Mock<(params?: unknown) => void>;
  getReconnectInfo: Mock<() => { lastConnectTime: number; nextConnectTime: number }>;
  handleControlData: AsyncControlHandler;
  originalHandleControlData: Mock<AsyncControlHandler>;
};

const clientCtorMock = vi.hoisted(() =>
  vi.fn(function clientCtor() {
    return { connected: true };
  }),
);
const rawWsClients = vi.hoisted((): MockRawWsClient[] => []);
const wsClientCtorMock = vi.hoisted(() =>
  vi.fn(function wsClientCtor() {
    const originalHandleControlData: Mock<AsyncControlHandler> = vi.fn(async () => {});
    const client: MockRawWsClient = {
      start: vi.fn(async () => {}),
      close: vi.fn(),
      getReconnectInfo: vi.fn(() => ({ lastConnectTime: 0, nextConnectTime: 0 })),
      handleControlData: originalHandleControlData,
      originalHandleControlData,
    };
    rawWsClients.push(client);
    return client;
  }),
);
const proxyAgentCtorMock = vi.hoisted(() =>
  vi.fn(function proxyAgentCtor() {
    return { proxied: true };
  }),
);
const mockBaseHttpInstance = vi.hoisted(() => ({
  request: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockResolvedValue({}),
  post: vi.fn().mockResolvedValue({}),
  put: vi.fn().mockResolvedValue({}),
  patch: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
  head: vi.fn().mockResolvedValue({}),
  options: vi.fn().mockResolvedValue({}),
}));
const proxyEnvKeys = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;
type ProxyEnvKey = (typeof proxyEnvKeys)[number];
const registerFeishuDocToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuChatToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuWikiToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuDriveToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuPermToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuBitableToolsMock = vi.hoisted(() => vi.fn());
const feishuPluginMock = vi.hoisted(() => ({ id: "feishu-test-plugin" }));
const setFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const registerFeishuSubagentHooksMock = vi.hoisted(() => vi.fn());

let createFeishuClient: CreateFeishuClient;
let createFeishuWSClient: CreateFeishuWSClient;
let clearClientCache: ClearClientCache;
let setFeishuClientRuntimeForTest: SetFeishuClientRuntimeForTest;
let FEISHU_HTTP_TIMEOUT_MS: number;
let FEISHU_HTTP_TIMEOUT_MAX_MS: number;
let FEISHU_HTTP_TIMEOUT_ENV_VAR: string;
let FEISHU_WS_START_TIMEOUT_MS: number;

let priorProxyEnv: Partial<Record<ProxyEnvKey, string | undefined>> = {};
let priorFeishuTimeoutEnv: string | undefined;

vi.mock("./channel.js", () => ({
  feishuPlugin: feishuPluginMock,
}));

vi.mock("./docx.js", () => ({
  registerFeishuDocTools: registerFeishuDocToolsMock,
}));

vi.mock("./chat.js", () => ({
  registerFeishuChatTools: registerFeishuChatToolsMock,
}));

vi.mock("./wiki.js", () => ({
  registerFeishuWikiTools: registerFeishuWikiToolsMock,
}));

vi.mock("./drive.js", () => ({
  registerFeishuDriveTools: registerFeishuDriveToolsMock,
}));

vi.mock("./perm.js", () => ({
  registerFeishuPermTools: registerFeishuPermToolsMock,
}));

vi.mock("./bitable.js", () => ({
  registerFeishuBitableTools: registerFeishuBitableToolsMock,
}));

vi.mock("./runtime.js", () => ({
  setFeishuRuntime: setFeishuRuntimeMock,
}));

vi.mock("./subagent-hooks.js", () => ({
  registerFeishuSubagentHooks: registerFeishuSubagentHooksMock,
}));

const baseAccount: ResolvedFeishuAccount = {
  accountId: "main",
  selectionSource: "explicit",
  enabled: true,
  configured: true,
  appId: "app_123",
  appSecret: "secret_123", // pragma: allowlist secret
  domain: "feishu",
  config: FeishuConfigSchema.parse({}),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type HttpInstanceLike = {
  get: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  post: (url: string, body?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
};

function readCallOptions(
  mock: { mock: { calls: unknown[][] } },
  index = -1,
): Record<string, unknown> {
  const call = index < 0 ? mock.mock.calls.at(index)?.[0] : mock.mock.calls[index]?.[0];
  return isRecord(call) ? call : {};
}

function firstWsClientOptions(): {
  agent?: unknown;
  autoReconnect?: unknown;
  wsConfig?: unknown;
  onReady?: () => void;
  onError?: (err: Error) => void;
  onReconnecting?: () => void;
} {
  const options = readCallOptions(wsClientCtorMock, 0);
  return {
    agent: options.agent,
    autoReconnect: options.autoReconnect,
    wsConfig: options.wsConfig,
    onReady: options.onReady as (() => void) | undefined,
    onError: options.onError as ((err: Error) => void) | undefined,
    onReconnecting: options.onReconnecting as (() => void) | undefined,
  };
}

function firstRawWsClient(): MockRawWsClient {
  const client = rawWsClients[0];
  if (!client) {
    throw new Error("expected Lark.WSClient mock to be constructed");
  }
  return client;
}

beforeAll(async () => {
  vi.doMock("@larksuiteoapi/node-sdk", () => ({
    AppType: { SelfBuild: "self" },
    Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
    LoggerLevel: { info: "info" },
    Client: clientCtorMock,
    WSClient: wsClientCtorMock,
    EventDispatcher: vi.fn(),
    defaultHttpInstance: mockBaseHttpInstance,
  }));
  vi.doMock("proxy-agent", () => ({
    ProxyAgent: proxyAgentCtorMock,
  }));

  ({
    createFeishuClient,
    createFeishuWSClient,
    clearClientCache,
    setFeishuClientRuntimeForTest,
    FEISHU_HTTP_TIMEOUT_MS,
    FEISHU_HTTP_TIMEOUT_MAX_MS,
    FEISHU_HTTP_TIMEOUT_ENV_VAR,
    FEISHU_WS_START_TIMEOUT_MS,
  } = await import("./client.js"));
});

beforeEach(() => {
  priorProxyEnv = {};
  priorFeishuTimeoutEnv = process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  delete process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  for (const key of proxyEnvKeys) {
    priorProxyEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.clearAllMocks();
  rawWsClients.length = 0;
  clearClientCache();
  setFeishuClientRuntimeForTest({
    sdk: {
      AppType: { SelfBuild: "self" } as never,
      Domain: {
        Feishu: "https://open.feishu.cn",
        Lark: "https://open.larksuite.com",
      } as never,
      LoggerLevel: { info: "info" } as never,
      Client: clientCtorMock as never,
      WSClient: wsClientCtorMock as never,
      EventDispatcher: vi.fn() as never,
      defaultHttpInstance: mockBaseHttpInstance as never,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const key of proxyEnvKeys) {
    const value = priorProxyEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (priorFeishuTimeoutEnv === undefined) {
    delete process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  } else {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = priorFeishuTimeoutEnv;
  }
  setFeishuClientRuntimeForTest();
});

describe("createFeishuClient HTTP timeout", () => {
  const getLastClientHttpInstance = (): HttpInstanceLike | undefined => {
    const httpInstance = readCallOptions(clientCtorMock).httpInstance;
    if (
      isRecord(httpInstance) &&
      typeof httpInstance.get === "function" &&
      typeof httpInstance.post === "function"
    ) {
      return {
        get: httpInstance.get as HttpInstanceLike["get"],
        post: httpInstance.post as HttpInstanceLike["post"],
      };
    }
    return undefined;
  };

  const expectGetCallTimeout = async (timeout: number) => {
    const httpInstance = getLastClientHttpInstance();
    expect(httpInstance).toBeDefined();
    await httpInstance?.get("https://example.com/api");
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout }),
    );
  };

  it("passes a custom httpInstance with default timeout to Lark.Client", () => {
    createFeishuClient({ appId: "app_1", appSecret: "secret_1", accountId: "timeout-test" }); // pragma: allowlist secret

    expect(readCallOptions(clientCtorMock).httpInstance).toBeDefined();
  });

  it("injects default timeout into HTTP request options", async () => {
    createFeishuClient({ appId: "app_2", appSecret: "secret_2", accountId: "timeout-inject" }); // pragma: allowlist secret

    const httpInstance = getLastClientHttpInstance();

    expect(httpInstance).toBeDefined();
    await httpInstance?.post(
      "https://example.com/api",
      { data: 1 },
      { headers: { "X-Custom": "yes" } },
    );

    expect(mockBaseHttpInstance.post).toHaveBeenCalledWith(
      "https://example.com/api",
      { data: 1 },
      expect.objectContaining({ timeout: FEISHU_HTTP_TIMEOUT_MS, headers: { "X-Custom": "yes" } }),
    );
  });

  it("allows explicit timeout override per-request", async () => {
    createFeishuClient({ appId: "app_3", appSecret: "secret_3", accountId: "timeout-override" }); // pragma: allowlist secret

    const httpInstance = getLastClientHttpInstance();

    expect(httpInstance).toBeDefined();
    await httpInstance?.get("https://example.com/api", { timeout: 5_000 });

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it("uses config-configured default timeout when provided", async () => {
    createFeishuClient({
      appId: "app_4",
      appSecret: "secret_4", // pragma: allowlist secret
      accountId: "timeout-config",
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(45_000);
  });

  it("falls back to default timeout when configured timeout is invalid", async () => {
    createFeishuClient({
      appId: "app_5",
      appSecret: "secret_5", // pragma: allowlist secret
      accountId: "timeout-config-invalid",
      config: { httpTimeoutMs: -1 },
    });

    await expectGetCallTimeout(FEISHU_HTTP_TIMEOUT_MS);
  });

  it("uses env timeout override when provided and no direct timeout is set", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = "60000";

    createFeishuClient({
      appId: "app_8",
      appSecret: "secret_8", // pragma: allowlist secret
      accountId: "timeout-env-override",
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(60_000);
  });

  it("prefers direct timeout over env override", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = "60000";

    createFeishuClient({
      appId: "app_10",
      appSecret: "secret_10", // pragma: allowlist secret
      accountId: "timeout-direct-override",
      httpTimeoutMs: 120_000,
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(120_000);
  });

  it("clamps env timeout override to max bound", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = String(FEISHU_HTTP_TIMEOUT_MAX_MS + 123_456);

    createFeishuClient({
      appId: "app_9",
      appSecret: "secret_9", // pragma: allowlist secret
      accountId: "timeout-env-clamp",
    });

    await expectGetCallTimeout(FEISHU_HTTP_TIMEOUT_MAX_MS);
  });

  it("recreates cached client when configured timeout changes", async () => {
    createFeishuClient({
      appId: "app_6",
      appSecret: "secret_6", // pragma: allowlist secret
      accountId: "timeout-cache-change",
      config: { httpTimeoutMs: 30_000 },
    });
    createFeishuClient({
      appId: "app_6",
      appSecret: "secret_6", // pragma: allowlist secret
      accountId: "timeout-cache-change",
      config: { httpTimeoutMs: 45_000 },
    });

    expect(clientCtorMock.mock.calls.length).toBe(2);
    const httpInstance = getLastClientHttpInstance();
    expect(httpInstance).toBeDefined();
    await httpInstance?.get("https://example.com/api");

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout: 45_000 }),
    );
  });
});

describe("createFeishuWSClient proxy handling", () => {
  it("uses Lark WSClient callbacks instead of unsupported wsConfig heartbeat overrides", async () => {
    await createFeishuWSClient(baseAccount);

    const options = firstWsClientOptions();
    expect(options.autoReconnect).toBe(true);
    expect(options.wsConfig).toBeUndefined();
    expect(options.onReady).toEqual(expect.any(Function));
    expect(options.onError).toEqual(expect.any(Function));
    expect(options.onReconnecting).toEqual(expect.any(Function));
  });

  it("resolves start only after the pinned SDK onReady callback fires", async () => {
    const client = await createFeishuWSClient(baseAccount);
    const options = firstWsClientOptions();

    let resolved = false;
    const start = client.start({ eventDispatcher: {} as never }).then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(firstRawWsClient().start).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    options.onReady?.();
    await start;

    expect(resolved).toBe(true);
  });

  it("closes the raw SDK client when startup waits outlive onReady", async () => {
    vi.useFakeTimers();
    const client = await createFeishuWSClient(baseAccount);
    const rawClient = firstRawWsClient();

    const start = client.start({ eventDispatcher: {} as never });
    const startExpectation = expect(start).rejects.toThrow(
      `Feishu WebSocket start timed out after ${FEISHU_WS_START_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(FEISHU_WS_START_TIMEOUT_MS);

    await startExpectation;
    expect(rawClient.close).toHaveBeenCalledWith({ force: true });
  });

  it("guards missing PingInterval pong frames on the client instance only", async () => {
    await createFeishuWSClient(baseAccount);
    const rawClient = firstRawWsClient();
    const frame = {
      headers: [{ key: "type", value: "pong" }],
      payload: new TextEncoder().encode(JSON.stringify({ ReconnectCount: 1 })),
    };

    await rawClient.handleControlData(frame);

    expect(rawClient.originalHandleControlData).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(rawClient, "handleControlData")).toBe(true);
  });

  it("still propagates non-PingInterval control handler failures", async () => {
    await createFeishuWSClient(baseAccount);
    const rawClient = firstRawWsClient();
    rawClient.originalHandleControlData.mockRejectedValueOnce(new Error("other control error"));

    await expect(rawClient.handleControlData({ headers: [] })).rejects.toThrow(
      "other control error",
    );
  });

  it("hands SDK reconnects back to the monitor and clears SDK reconnect timers", async () => {
    const client = await createFeishuWSClient(baseAccount);
    const rawClient = firstRawWsClient();
    const options = firstWsClientOptions();
    const terminalError = client.waitForTerminalError();

    options.onReconnecting?.();
    await Promise.resolve();

    await expect(terminalError).resolves.toMatchObject({
      message: expect.stringContaining("reconnecting through OpenClaw monitor backoff"),
    });
    expect(rawClient.close).toHaveBeenCalledWith({ force: true });
  });

  it("does not set a ws proxy agent when proxy env is absent", async () => {
    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).not.toHaveBeenCalled();
    const options = firstWsClientOptions();
    expect(options.agent).toBeUndefined();
  });

  it("creates a ws proxy agent when lowercase https_proxy is set", async () => {
    process.env.https_proxy = "http://lower-https:8001";

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxied: true });
  });

  it("creates a ws proxy agent when uppercase HTTPS_PROXY is set", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxied: true });
  });

  it("falls back to HTTP_PROXY for ws proxy agent creation", async () => {
    process.env.HTTP_PROXY = "http://upper-http:8999";

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxied: true });
  });
});
