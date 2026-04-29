import { afterEach, describe, expect, it, vi } from "vitest";
import { botNames, botOpenIds, stopFeishuMonitorState, wsClients } from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuWSClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuWSClient: createFeishuWSClientMock,
  isFeishuWebSocketClientClosedError: (err: unknown) =>
    !!err && typeof err === "object" && "feishuWsClientClosed" in err,
  isFeishuWebSocketReconnectRequiredError: (err: unknown) =>
    !!err && typeof err === "object" && "feishuWsReconnectRequired" in err,
}));

import { monitorWebSocket } from "./monitor.transport.js";

type MockWsClient = {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  waitForTerminalError: ReturnType<typeof vi.fn>;
};

function createAccount(accountId: string): ResolvedFeishuAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    appId: `cli_${accountId}`,
    appSecret: `secret_${accountId}`, // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function createWsClient(terminalError?: Promise<Error>): MockWsClient {
  return {
    start: vi.fn(),
    close: vi.fn(),
    waitForTerminalError: vi.fn(() => terminalError ?? new Promise<Error>(() => {})),
  };
}

function createMarkedError(
  message: string,
  marker: "feishuWsClientClosed" | "feishuWsReconnectRequired",
): Error {
  return Object.assign(new Error(message), { [marker]: true });
}

afterEach(() => {
  vi.useRealTimers();
  stopFeishuMonitorState();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("feishu websocket cleanup", () => {
  it("closes the websocket client when the monitor aborts", async () => {
    const wsClient = createWsClient();
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const accountId = "alpha";

    botOpenIds.set(accountId, "ou_alpha");
    botNames.set(accountId, "Alpha");

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get(accountId)).toBe(wsClient);
    });

    abortController.abort();
    await monitorPromise;

    expect(wsClient.close).toHaveBeenCalledTimes(1);
    expect(wsClients.has(accountId)).toBe(false);
    expect(botOpenIds.has(accountId)).toBe(false);
    expect(botNames.has(accountId)).toBe(false);
  });

  it("retries with backoff after websocket start rejects", async () => {
    vi.useFakeTimers();
    const failedClient = createWsClient();
    failedClient.start.mockRejectedValueOnce(
      new Error("connect failed\nAuthorization: Bearer token_abc appSecret=secret_abc"),
    );
    const recoveredClient = createWsClient();
    createFeishuWSClientMock
      .mockResolvedValueOnce(failedClient)
      .mockResolvedValueOnce(recoveredClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const accountId = "retry";

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(failedClient.start).toHaveBeenCalledTimes(1);
      expect(failedClient.close).toHaveBeenCalledTimes(1);
      expect(wsClients.has(accountId)).toBe(false);
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(recoveredClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get(accountId)).toBe(recoveredClient);
    });

    abortController.abort();
    await monitorPromise;

    expect(createFeishuWSClientMock).toHaveBeenCalledTimes(2);
    expect(recoveredClient.close).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("WebSocket start failed, retrying in 1000ms"),
    );
    const errorMessage = String(runtime.error.mock.calls[0]?.[0] ?? "");
    expect(errorMessage).not.toContain("\n");
    expect(errorMessage).not.toContain("token_abc");
    expect(errorMessage).not.toContain("secret_abc");
    expect(errorMessage).toContain("Authorization: Bearer [redacted]");
    expect(errorMessage).toContain("appSecret=[redacted]");
  });

  it("closes the websocket client when aborted during startup", async () => {
    const wsClient = createWsClient();
    wsClient.start.mockReturnValueOnce(new Promise<void>(() => {}));
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const monitorPromise = monitorWebSocket({
      account: createAccount("startup-abort"),
      accountId: "startup-abort",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get("startup-abort")).toBe(wsClient);
    });

    abortController.abort();
    await monitorPromise;

    expect(wsClient.close).toHaveBeenCalledTimes(1);
    expect(wsClients.has("startup-abort")).toBe(false);
  });

  it("resets startup backoff after a successful websocket start", async () => {
    vi.useFakeTimers();
    const failedClient = createWsClient();
    failedClient.start.mockRejectedValueOnce(new Error("first connect failed"));
    let failRecoveredClient!: (err: Error) => void;
    const recoveredFailure = new Promise<Error>((resolve) => {
      failRecoveredClient = resolve;
    });
    const recoveredClient = createWsClient(recoveredFailure);
    const finalClient = createWsClient();
    createFeishuWSClientMock
      .mockResolvedValueOnce(failedClient)
      .mockResolvedValueOnce(recoveredClient)
      .mockResolvedValueOnce(finalClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const monitorPromise = monitorWebSocket({
      account: createAccount("reset"),
      accountId: "reset",
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(failedClient.close).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(recoveredClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get("reset")).toBe(recoveredClient);
    });

    failRecoveredClient(new Error("post-success failure"));
    await vi.waitFor(() => {
      expect(recoveredClient.close).toHaveBeenCalledTimes(1);
    });

    const errorMessages = runtime.error.mock.calls.map((call) => String(call[0]));
    expect(errorMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("WebSocket start failed, retrying in 1000ms: first connect failed"),
        expect.stringContaining("WebSocket start failed, retrying in 1000ms: post-success failure"),
      ]),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(finalClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get("reset")).toBe(finalClient);
    });

    abortController.abort();
    await monitorPromise;
  });

  it("uses monitor-owned reconnect backoff after the SDK enters reconnecting", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    let triggerReconnect!: (err: Error) => void;
    const reconnectSignal = new Promise<Error>((resolve) => {
      triggerReconnect = resolve;
    });
    const wsClient = createWsClient(reconnectSignal);
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const monitorPromise = monitorWebSocket({
      account: createAccount("reconnect"),
      accountId: "reconnect",
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
    });

    triggerReconnect(createMarkedError("sdk reconnect handoff", "feishuWsReconnectRequired"));
    await vi.waitFor(() => {
      expect(wsClient.close).toHaveBeenCalledTimes(1);
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("WebSocket disconnected, retrying in 120000ms"),
    );
    expect(createFeishuWSClientMock).toHaveBeenCalledTimes(1);

    abortController.abort();
    await monitorPromise;
    randomSpy.mockRestore();
  });

  it("redacts websocket close errors during abort cleanup", async () => {
    const wsClient = createWsClient();
    wsClient.close.mockImplementationOnce(() => {
      throw new Error("close failed\naccess_token=secret_token");
    });
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const monitorPromise = monitorWebSocket({
      account: createAccount("close-error"),
      accountId: "close-error",
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
    });

    abortController.abort();
    await monitorPromise;

    const errorMessage = String(runtime.error.mock.calls[0]?.[0] ?? "");
    expect(errorMessage).toContain("error closing WebSocket client");
    expect(errorMessage).toContain("access_token=[redacted]");
    expect(errorMessage).not.toContain("\n");
    expect(errorMessage).not.toContain("secret_token");
  });

  it("closes targeted websocket clients during stop cleanup", () => {
    const alphaClient = createWsClient();
    const betaClient = createWsClient();

    wsClients.set("alpha", alphaClient as never);
    wsClients.set("beta", betaClient as never);
    botOpenIds.set("alpha", "ou_alpha");
    botOpenIds.set("beta", "ou_beta");
    botNames.set("alpha", "Alpha");
    botNames.set("beta", "Beta");

    stopFeishuMonitorState("alpha");

    expect(alphaClient.close).toHaveBeenCalledTimes(1);
    expect(betaClient.close).not.toHaveBeenCalled();
    expect(wsClients.has("alpha")).toBe(false);
    expect(wsClients.has("beta")).toBe(true);
    expect(botOpenIds.has("alpha")).toBe(false);
    expect(botOpenIds.has("beta")).toBe(true);
    expect(botNames.has("alpha")).toBe(false);
    expect(botNames.has("beta")).toBe(true);
  });

  it("closes all websocket clients during global stop cleanup", () => {
    const alphaClient = createWsClient();
    const betaClient = createWsClient();

    wsClients.set("alpha", alphaClient as never);
    wsClients.set("beta", betaClient as never);
    botOpenIds.set("alpha", "ou_alpha");
    botOpenIds.set("beta", "ou_beta");
    botNames.set("alpha", "Alpha");
    botNames.set("beta", "Beta");

    stopFeishuMonitorState();

    expect(alphaClient.close).toHaveBeenCalledTimes(1);
    expect(betaClient.close).toHaveBeenCalledTimes(1);
    expect(wsClients.size).toBe(0);
    expect(botOpenIds.size).toBe(0);
    expect(botNames.size).toBe(0);
  });
});
