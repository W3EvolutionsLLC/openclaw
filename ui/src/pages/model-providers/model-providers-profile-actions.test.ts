/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import "./model-providers-page.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

type ModelProvidersPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  data: ModelProvidersData | null;
  requestProfileLogout: (
    cardId: string,
    provider: string,
    owner: string,
    profileId: string,
    label: string,
  ) => Promise<void>;
  messages: Record<
    string,
    { kind: "success" | "warning" | "error"; text: string; warning?: string }
  >;
  refresh: (opts: { force: boolean; requireApplied?: boolean }) => Promise<void>;
  routeData: ModelProvidersRouteData | undefined;
};

function createHarness(initialScopeId: string) {
  let authStatusResponse: () => NonNullable<ModelProvidersData["authStatus"]> = () => ({
    ts: 1,
    providers: [],
  });
  let pendingAuthStatus: Promise<void> | null = null;
  let releaseAuthStatus: (() => void) | null = null;
  const deferNextAuthStatus = () => {
    pendingAuthStatus = new Promise<void>((resolve) => {
      releaseAuthStatus = resolve;
    });
    return () => releaseAuthStatus?.();
  };
  const request = vi.fn(async (method: string): Promise<unknown> => {
    switch (method) {
      case "models.authStatus": {
        if (pendingAuthStatus) {
          const gate = pendingAuthStatus;
          pendingAuthStatus = null;
          await gate;
        }
        return authStatusResponse();
      }
      case "models.list":
        return { models: [] };
      case "config.get":
        return { config: {}, hash: "hash" };
      case "usage.status":
        return { updatedAt: 1, providers: [] };
      case "sessions.usage":
        return { aggregates: { byProvider: [] } };
      default:
        return {};
    }
  });
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  let selectionListener: (() => void) | undefined;
  const agentSelection = {
    state: { selectedId: initialScopeId, scopeId: initialScopeId as string | null },
    set: vi.fn(),
    setScope: vi.fn(),
    subscribe(listener: () => void) {
      selectionListener = listener;
      return () => {
        selectionListener = undefined;
      };
    },
  };
  const subscribe = () => () => undefined;
  const runtimeConfig = {
    state: {
      connected: true,
      configSnapshot: { config: {} },
      configForm: {
        agents: { defaults: { thinkingDefault: "low", fastModeDefault: "auto" } },
      },
      configLoading: false,
      configSaving: false,
      configApplying: false,
      configNeedsApply: false,
      configFormMode: "form",
      configFormDirty: false,
      configAutoSaveStatus: "idle",
      lastError: null as string | null,
    },
    ensureLoaded: vi.fn(async (): Promise<void> => undefined),
    patch: vi.fn(async () => true),
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    refresh: vi.fn(async () => undefined),
    save: vi.fn(async () => true),
    apply: vi.fn(async () => true),
    discardDraft: vi.fn(async () => undefined),
    subscribe,
  };
  const context = {
    gateway: { snapshot, subscribe },
    agents: {
      state: {
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "project",
          agents: [
            { id: "main", name: "Main" },
            { id: "writer", name: "Writer" },
          ],
        },
        agentsLoading: false,
      },
      ensureList: vi.fn(),
      subscribe,
    },
    agentSelection,
    runtimeConfig,
    overlays: {
      snapshot: { updateRunning: false, updateReconciliationPending: false },
      subscribe,
    },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  return {
    agentSelection,
    context,
    deferNextAuthStatus,
    notifySelection: () => selectionListener?.(),
    request,
    runtimeConfig,
    setAuthStatusResponse: (read: typeof authStatusResponse) => (authStatusResponse = read),
    snapshot,
  };
}

function appendPage(context: ApplicationContext) {
  const page = document.createElement(
    "openclaw-model-providers-page",
  ) as ModelProvidersPageTestElement;
  page.context = context;
  document.body.append(page);
  return page;
}

function authOrderRequests(request: ReturnType<typeof createHarness>["request"]) {
  return request.mock.calls.filter(([method]) => method === "models.authOrderSet");
}

function renderedProfileIds(page: ModelProvidersPageTestElement) {
  return [...page.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
    (row) => row.dataset.profileId,
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage profile actions", () => {
  it("serializes profile logout behind an in-flight order save", async () => {
    vi.mocked(showConfirmDialog).mockClear();
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      updatedAt: 1,
      authStatus: {
        ts: 1,
        providers: [
          {
            provider: "openai",
            authProvider: "openai",
            displayName: "OpenAI",
            status: "ok",
            profiles: ["primary", "backup"].map((suffix) => ({
              profileId: `openai:${suffix}`,
              type: "oauth" as const,
              status: "ok" as const,
              logoutSupported: true,
            })),
            profileOrder: ["openai:primary", "openai:backup"],
          },
        ],
      },
    };
    await page.updateComplete;
    request.mockClear();
    const pendingOrder = createDeferred<unknown>();
    request.mockImplementation(
      async (method: string): Promise<unknown> =>
        method === "models.authOrderSet" ? pendingOrder.promise : {},
    );

    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:primary"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "openai",
        profileIds: ["openai:backup", "openai:primary"],
        expectedProfileIds: ["openai:primary", "openai:backup"],
        expectedProfileMembership: ["openai:primary", "openai:backup"],
        agentId: "main",
      }),
    );

    const logout = page.requestProfileLogout(
      "openai",
      "openai",
      "openai",
      "openai:primary",
      "openai:primary",
    );
    await vi.waitFor(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    await page.updateComplete;
    expect(
      page.querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:primary"] .model-providers__profile-logout',
      )?.disabled,
    ).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "models.authLogout")).toBe(false);

    pendingOrder.resolve({});
    await logout;
    expect(request).toHaveBeenCalledWith("models.authLogout", {
      provider: "openai",
      profileIds: ["openai:primary"],
      agentId: "main",
    });
  });

  it("keeps reordering during a save and rolls back a failed queued order", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      updatedAt: 1,
      authStatus: {
        ts: 1,
        providers: [
          {
            provider: "openai",
            authProvider: "openai",
            displayName: "OpenAI",
            status: "ok",
            profiles: ["primary", "backup"].map((suffix) => ({
              profileId: `openai:${suffix}`,
              type: "oauth" as const,
              status: "ok" as const,
              email: `${suffix}@example.com`,
            })),
            profileOrder: ["openai:primary", "openai:backup"],
          },
        ],
      },
    };
    await page.updateComplete;
    request.mockClear();
    const pendingOrder = createDeferred<unknown>();
    request.mockImplementationOnce(async () => pendingOrder.promise);

    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:primary"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "openai",
        profileIds: ["openai:backup", "openai:primary"],
        expectedProfileIds: ["openai:primary", "openai:backup"],
        expectedProfileMembership: ["openai:primary", "openai:backup"],
        agentId: "main",
      }),
    );
    await page.updateComplete;

    expect(renderedProfileIds(page)).toEqual(["openai:backup", "openai:primary"]);
    expect(
      [...page.querySelectorAll<HTMLButtonElement>(".model-providers__profile-grip")].every(
        (grip) => !grip.disabled,
      ),
    ).toBe(true);

    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:backup"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await page.updateComplete;
    expect(renderedProfileIds(page)).toEqual(["openai:primary", "openai:backup"]);

    const authStatus = page.data?.authStatus;
    if (!authStatus) {
      throw new Error("expected auth status fixture");
    }
    const authoritativeAuthStatus = {
      ...authStatus,
      providers: authStatus.providers.map((provider) =>
        Object.assign({}, provider, { profileOrder: ["openai:backup", "openai:primary"] }),
      ),
    };
    request.mockImplementation(async (method): Promise<unknown> => {
      switch (method) {
        case "models.authStatus":
          return authoritativeAuthStatus;
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    request.mockRejectedValueOnce(new Error("Order save failed"));
    pendingOrder.resolve({});
    await vi.waitFor(() => expect(authOrderRequests(request)).toHaveLength(2));
    await vi.waitFor(() =>
      expect(page.messages["profiles:openai"]?.text).toBe("Order save failed"),
    );
    await page.updateComplete;
    expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("models.authOrderSet", {
      provider: "openai",
      profileIds: ["openai:primary", "openai:backup"],
      expectedProfileIds: ["openai:backup", "openai:primary"],
      expectedProfileMembership: ["openai:primary", "openai:backup"],
      agentId: "main",
    });
    expect(renderedProfileIds(page)).toEqual(["openai:backup", "openai:primary"]);
    expect(page.querySelector('.model-providers__profiles [role="alert"]')?.textContent).toContain(
      "Order save failed",
    );
  });

  it("reconciles automatic profile membership behind an in-flight order save", async () => {
    const { context, request, setAuthStatusResponse, snapshot } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      updatedAt: 1,
      authStatus: {
        ts: 1,
        providers: [
          {
            provider: "openai",
            authProvider: "openai",
            displayName: "OpenAI",
            status: "ok",
            profiles: ["one", "two", "three"].map((suffix) => ({
              profileId: `openai:${suffix}`,
              type: "oauth" as const,
              status: "ok" as const,
            })),
          },
        ],
      },
    };
    await page.updateComplete;
    request.mockClear();
    const firstSave = createDeferred<unknown>();
    request.mockImplementationOnce(async () => firstSave.promise);

    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "openai",
        profileIds: ["openai:two", "openai:one", "openai:three"],
        expectedProfileIds: null,
        expectedProfileMembership: ["openai:one", "openai:two", "openai:three"],
        agentId: "main",
      }),
    );

    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: snapshot,
      agentId: "main",
      client: snapshot.client!,
      data: {
        ...(page.data ?? EMPTY_MODEL_PROVIDERS_DATA),
        authStatus: {
          ts: 2,
          providers: [
            {
              provider: "openai",
              authProvider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [
                { profileId: "openai:one", type: "oauth", status: "ok" },
                { profileId: "openai:two", type: "oauth", status: "ok" },
                { profileId: "openai:four", type: "oauth", status: "ok" },
              ],
            },
          ],
        },
      },
    };
    await page.updateComplete;
    setAuthStatusResponse(() => page.data?.authStatus ?? { ts: 1, providers: [] });
    expect(authOrderRequests(request)).toHaveLength(1);

    firstSave.resolve({});
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "openai",
        profileIds: ["openai:two", "openai:one", "openai:four"],
        expectedProfileIds: ["openai:two", "openai:one", "openai:three"],
        expectedProfileMembership: ["openai:one", "openai:two", "openai:four"],
        agentId: "main",
      }),
    );
    await vi.waitFor(() =>
      expect(page.data?.authStatus?.providers[0]?.profileOrder).toEqual([
        "openai:two",
        "openai:one",
        "openai:four",
      ]),
    );
  });

  it("keeps an optimistic explicit-order rejoin through a stale refresh", async () => {
    const { context, request, setAuthStatusResponse, snapshot } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    const profiles = ["one", "two", "excluded"].map((suffix) => ({
      profileId: `openai:${suffix}`,
      type: "oauth" as const,
      status: "ok" as const,
    }));
    const staleProvider = {
      provider: "openai",
      authProvider: "openai",
      displayName: "OpenAI",
      status: "ok" as const,
      profiles,
      profileOrder: ["openai:one", "openai:two"],
    };
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      updatedAt: 1,
      authStatus: { ts: 1, providers: [staleProvider] },
    };
    await page.updateComplete;
    request.mockClear();
    const firstSave = createDeferred<unknown>();
    request.mockImplementationOnce(async () => firstSave.promise);

    page
      .querySelector<HTMLElement>('[data-profile-id="openai:excluded"]')
      ?.querySelector<HTMLButtonElement>(".model-providers__profile-action")
      ?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "openai",
        profileIds: ["openai:one", "openai:two", "openai:excluded"],
        expectedProfileIds: ["openai:one", "openai:two"],
        expectedProfileMembership: ["openai:one", "openai:two", "openai:excluded"],
        agentId: "main",
      }),
    );

    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: snapshot,
      agentId: "main",
      client: snapshot.client!,
      data: {
        ...(page.data ?? EMPTY_MODEL_PROVIDERS_DATA),
        authStatus: { ts: 2, providers: [staleProvider] },
      },
    };
    await page.updateComplete;
    setAuthStatusResponse(() => page.data?.authStatus ?? { ts: 1, providers: [] });
    expect(
      page
        .querySelector('[data-profile-id="openai:excluded"]')
        ?.querySelector(".model-providers__profile-action"),
    ).toBeNull();

    firstSave.resolve({});
    await vi.waitFor(() =>
      expect(page.data?.authStatus?.providers[0]?.profileOrder).toEqual([
        "openai:one",
        "openai:two",
        "openai:excluded",
      ]),
    );
    expect(authOrderRequests(request)).toHaveLength(1);
  });

  it("supersedes a stale pending refresh before saving profile order", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    const initialProvider = {
      provider: "openai",
      authProvider: "openai",
      displayName: "OpenAI",
      status: "ok" as const,
      profiles: [
        { profileId: "openai:one", type: "oauth" as const, status: "ok" as const },
        { profileId: "openai:two", type: "oauth" as const, status: "ok" as const },
      ],
      profileOrder: ["openai:one", "openai:two"],
    };
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      updatedAt: 1,
      authStatus: { ts: 1, providers: [initialProvider] },
    };
    await page.updateComplete;
    const staleRefresh = createDeferred();
    let authStatusCalls = 0;
    request.mockImplementation(async (method: string): Promise<unknown> => {
      switch (method) {
        case "models.authStatus":
          authStatusCalls += 1;
          if (authStatusCalls === 1) {
            await staleRefresh.promise;
            return { ts: 2, providers: [initialProvider] };
          }
          return {
            ts: 3,
            providers: [{ ...initialProvider, profileOrder: ["openai:two", "openai:one"] }],
          };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });

    const refreshing = page.refresh({ force: true });
    await vi.waitFor(() => expect(authStatusCalls).toBe(1));
    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "openai",
        profileIds: ["openai:two", "openai:one"],
        expectedProfileIds: ["openai:one", "openai:two"],
        expectedProfileMembership: ["openai:one", "openai:two"],
        agentId: "main",
      }),
    );
    await vi.waitFor(() =>
      expect(page.data?.authStatus?.providers[0]?.profileOrder).toEqual([
        "openai:two",
        "openai:one",
      ]),
    );

    staleRefresh.resolve();
    await refreshing;
    expect(page.data?.authStatus?.providers[0]?.profileOrder).toEqual(["openai:two", "openai:one"]);
  });

  it("supersedes a refresh started after an order save is dispatched", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    const profiles = ["one", "two"].map((suffix) => ({
      profileId: `openai:${suffix}`,
      type: "oauth" as const,
      status: "ok" as const,
    }));
    const staleProvider = {
      provider: "openai",
      authProvider: "openai",
      displayName: "OpenAI",
      status: "ok" as const,
      profiles,
      profileOrder: ["openai:one", "openai:two"],
    };
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      updatedAt: 1,
      authStatus: { ts: 1, providers: [staleProvider] },
    };
    await page.updateComplete;
    request.mockClear();
    const orderSave = createDeferred<unknown>();
    const staleRefresh = createDeferred();
    let authStatusCalls = 0;
    request.mockImplementation(async (method: string): Promise<unknown> => {
      switch (method) {
        case "models.authOrderSet":
          return orderSave.promise;
        case "models.authStatus":
          authStatusCalls += 1;
          if (authStatusCalls === 1) {
            await staleRefresh.promise;
            return { ts: 2, providers: [staleProvider] };
          }
          return {
            ts: 3,
            providers: [{ ...staleProvider, profileOrder: ["openai:two", "openai:one"] }],
          };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });

    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", expect.anything()),
    );
    const refreshing = page.refresh({ force: true });
    await vi.waitFor(() => expect(authStatusCalls).toBe(1));
    orderSave.resolve({});
    await vi.waitFor(() =>
      expect(page.data?.authStatus?.providers[0]?.profileOrder).toEqual([
        "openai:two",
        "openai:one",
      ]),
    );
    staleRefresh.resolve();
    await refreshing;

    expect(page.data?.authStatus?.providers[0]?.profileOrder).toEqual(["openai:two", "openai:one"]);
  });

  it("keeps alias rows synchronized after their shared order is saved", async () => {
    const { context, request, setAuthStatusResponse } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    const sharedOrder = ["anthropic:one", "claude-cli:two"];
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      updatedAt: 1,
      authStatus: {
        ts: 1,
        providers: [
          {
            provider: "anthropic",
            authProvider: "anthropic",
            displayName: "Claude",
            status: "ok",
            profiles: [{ profileId: "anthropic:one", type: "oauth", status: "ok" }],
            profileOrder: sharedOrder,
            usage: { providerId: "anthropic", windows: [] },
          },
          {
            provider: "claude-cli",
            authProvider: "anthropic",
            displayName: "Claude",
            status: "ok",
            profiles: [{ profileId: "claude-cli:two", type: "token", status: "ok" }],
            profileOrder: sharedOrder,
            usage: { providerId: "anthropic", windows: [] },
          },
        ],
      },
    };
    await page.updateComplete;
    setAuthStatusResponse(() => page.data?.authStatus ?? { ts: 1, providers: [] });
    request.mockClear();
    const firstSave = createDeferred<unknown>();
    request.mockImplementationOnce(async () => firstSave.promise);

    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="claude-cli:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "anthropic",
        profileIds: ["claude-cli:two", "anthropic:one"],
        expectedProfileIds: ["anthropic:one", "claude-cli:two"],
        expectedProfileMembership: ["anthropic:one", "claude-cli:two"],
        agentId: "main",
      }),
    );
    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="anthropic:one"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await page.updateComplete;
    expect(authOrderRequests(request)).toHaveLength(1);

    firstSave.resolve({});
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "anthropic",
        profileIds: ["anthropic:one", "claude-cli:two"],
        expectedProfileIds: ["claude-cli:two", "anthropic:one"],
        expectedProfileMembership: ["anthropic:one", "claude-cli:two"],
        agentId: "main",
      }),
    );
    await vi.waitFor(() =>
      expect(page.data?.authStatus?.providers.map((provider) => provider.profileOrder)).toEqual([
        ["anthropic:one", "claude-cli:two"],
        ["anthropic:one", "claude-cli:two"],
      ]),
    );
    await page.updateComplete;
    expect(renderedProfileIds(page)).toEqual(["anthropic:one", "claude-cli:two"]);
  });

  it("serializes shared-owner reorders submitted from separate cards", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    const sharedOrder = ["first:one", "second:two"];
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      updatedAt: 1,
      authStatus: {
        ts: 1,
        providers: [
          {
            provider: "first",
            authProvider: "shared-owner",
            displayName: "First",
            status: "ok",
            profiles: [{ profileId: "first:one", type: "oauth", status: "ok" }],
            profileOrder: sharedOrder,
            usage: { providerId: "first", windows: [] },
          },
          {
            provider: "second",
            authProvider: "shared-owner",
            displayName: "Second",
            status: "ok",
            profiles: [{ profileId: "second:two", type: "token", status: "ok" }],
            profileOrder: sharedOrder,
            usage: { providerId: "second", windows: [] },
          },
        ],
      },
    };
    await page.updateComplete;
    request.mockClear();
    const firstSave = createDeferred<unknown>();
    request.mockImplementationOnce(async () => firstSave.promise);

    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="second:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "first",
        profileIds: ["second:two", "first:one"],
        expectedProfileIds: ["first:one", "second:two"],
        expectedProfileMembership: ["first:one", "second:two"],
        agentId: "main",
      }),
    );

    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="first:one"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(authOrderRequests(request)).toHaveLength(1);

    firstSave.resolve({});
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "first",
        profileIds: ["first:one", "second:two"],
        expectedProfileIds: ["second:two", "first:one"],
        expectedProfileMembership: ["first:one", "second:two"],
        agentId: "main",
      }),
    );
  });

  it("waits for a shared-owner reorder before logging out from another card", async () => {
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    const sharedOrder = ["first:one", "second:two"];
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      updatedAt: 1,
      authStatus: {
        ts: 1,
        providers: [
          {
            provider: "first",
            authProvider: "shared-owner",
            displayName: "First",
            status: "ok",
            profiles: [
              {
                profileId: "first:one",
                type: "oauth",
                status: "ok",
                logoutSupported: true,
              },
            ],
            profileOrder: sharedOrder,
            usage: { providerId: "first", windows: [] },
          },
          {
            provider: "second",
            authProvider: "shared-owner",
            displayName: "Second",
            status: "ok",
            profiles: [{ profileId: "second:two", type: "token", status: "ok" }],
            profileOrder: sharedOrder,
            usage: { providerId: "second", windows: [] },
          },
        ],
      },
    };
    await page.updateComplete;
    request.mockClear();
    const pendingOrder = createDeferred<unknown>();
    request.mockImplementation(
      async (method: string): Promise<unknown> =>
        method === "models.authOrderSet" ? pendingOrder.promise : {},
    );

    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="second:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", expect.anything()),
    );
    const logout = page.requestProfileLogout(
      "first",
      "first",
      "shared-owner",
      "first:one",
      "First",
    );
    await vi.waitFor(() => expect(showConfirmDialog).toHaveBeenCalled());
    expect(request.mock.calls.some(([method]) => method === "models.authLogout")).toBe(false);

    pendingOrder.resolve({});
    await logout;
    expect(request).toHaveBeenCalledWith("models.authLogout", {
      provider: "first",
      profileIds: ["first:one"],
      agentId: "main",
    });
  });

  it("reports a failed owner order while continuing another owner on the same card", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await vi.waitFor(() => expect(page.data?.config).toEqual({}));
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      updatedAt: 1,
      authStatus: {
        ts: 1,
        providers: [
          {
            provider: "minimax",
            authProvider: "minimax",
            displayName: "MiniMax",
            status: "ok",
            profiles: ["one", "two"].map((suffix) => ({
              profileId: `minimax:${suffix}`,
              type: "oauth" as const,
              status: "ok" as const,
            })),
            profileOrder: ["minimax:one", "minimax:two"],
            usage: { providerId: "minimax", windows: [] },
          },
          {
            provider: "minimax-portal",
            authProvider: "minimax-portal",
            displayName: "MiniMax",
            status: "ok",
            profiles: ["one", "two"].map((suffix) => ({
              profileId: `minimax-portal:${suffix}`,
              type: "oauth" as const,
              status: "ok" as const,
            })),
            profileOrder: ["minimax-portal:one", "minimax-portal:two"],
            usage: { providerId: "minimax", windows: [] },
          },
        ],
      },
    };
    await page.updateComplete;
    request.mockClear();
    const firstSave = createDeferred<unknown>();
    request.mockImplementationOnce(async () => firstSave.promise);

    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="minimax:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "minimax",
        profileIds: ["minimax:two", "minimax:one"],
        expectedProfileIds: ["minimax:one", "minimax:two"],
        expectedProfileMembership: ["minimax:one", "minimax:two"],
        agentId: "main",
      }),
    );
    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="minimax-portal:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    firstSave.reject(new Error("MiniMax order save failed"));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "minimax-portal",
        profileIds: ["minimax-portal:two", "minimax-portal:one"],
        expectedProfileIds: ["minimax-portal:one", "minimax-portal:two"],
        expectedProfileMembership: ["minimax-portal:one", "minimax-portal:two"],
        agentId: "main",
      }),
    );
    await vi.waitFor(() =>
      expect(page.messages["profiles:minimax"]?.text).toBe("MiniMax order save failed"),
    );
  });
});
