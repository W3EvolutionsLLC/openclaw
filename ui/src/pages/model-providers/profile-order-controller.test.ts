import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import { ProfileOrderController, type ProfileOrderDrafts } from "./profile-order-controller.ts";

function createHarness() {
  const order = createDeferred<unknown>();
  const cooldown = createDeferred<unknown>();
  const request = vi.fn((method: string): Promise<unknown> => {
    if (method === "models.authOrderSet") {
      return order.promise;
    }
    if (method === "models.authCooldownClear") {
      return cooldown.promise;
    }
    return Promise.resolve({});
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected",
    hello: null,
  } as unknown as ApplicationGatewaySnapshot;
  let data: ModelProvidersData = {
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
          profiles: [
            { profileId: "openai:one", type: "oauth", status: "ok" },
            { profileId: "openai:two", type: "oauth", status: "ok" },
          ],
          profileOrder: ["openai:one", "openai:two"],
        },
      ],
    },
  };
  let drafts: ProfileOrderDrafts = {};
  const busy: Record<string, boolean> = {};
  const refresh = vi.fn(async () => undefined);
  const setMessage = vi.fn();
  const controller = new ProfileOrderController({
    snapshot: () => snapshot,
    current: () => ({ agentEpoch: 1, agentId: "main", clientEpoch: 1 }),
    canMutate: () => true,
    isBusy: (key) => Boolean(busy[key]),
    isCurrentClient: (candidate, epoch) => candidate === client && epoch === 1,
    prepareForMutation: vi.fn(),
    refresh,
    clearProbe: vi.fn(),
    getData: () => data,
    setData: (next) => {
      data = next;
    },
    getDrafts: () => drafts,
    setDrafts: (next) => {
      drafts = next;
    },
    setBusy: (key, value) => {
      busy[key] = value;
    },
    setMessage,
  });
  const setAuthoritativeOrder = (profileOrder: string[]) => {
    const authStatus = data.authStatus;
    if (!authStatus) {
      throw new Error("auth status missing");
    }
    for (const provider of authStatus.providers) {
      provider.profileOrder = [...profileOrder];
    }
  };
  return {
    busy,
    controller,
    cooldown,
    getData: () => data,
    order,
    refresh,
    request,
    setMessage,
    setAuthoritativeOrder,
  };
}

describe("ProfileOrderController concurrency", () => {
  it("sends the saved order used to build a reorder", async () => {
    const { controller, order, refresh, request } = createHarness();

    controller.queue("openai", ["openai:two", "openai:one"]);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "openai",
        profileIds: ["openai:two", "openai:one"],
        expectedProfileIds: ["openai:one", "openai:two"],
        expectedProfileMembership: ["openai:one", "openai:two"],
        agentId: "main",
      }),
    );
    order.resolve({});
    await controller.waitFor("openai");

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("uses one alias row as the displayed order and locked mutation source", async () => {
    const { controller, getData, order, request } = createHarness();
    const authStatus = getData().authStatus;
    const canonical = authStatus?.providers[0];
    if (!authStatus || !canonical) {
      throw new Error("auth status missing");
    }
    canonical.provider = "anthropic";
    canonical.authProvider = "anthropic";
    authStatus.providers = [
      {
        ...canonical,
        provider: "claude-cli",
        profileOrder: ["openai:two", "openai:one"],
      },
      canonical,
    ];

    controller.queue("claude-cli", ["openai:one", "openai:two"]);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authOrderSet", {
        provider: "claude-cli",
        profileIds: ["openai:one", "openai:two"],
        expectedProfileIds: ["openai:two", "openai:one"],
        expectedProfileMembership: ["openai:one", "openai:two"],
        agentId: "main",
      }),
    );
    order.resolve({});
    await controller.waitFor("anthropic");
  });

  it("keeps an acknowledged cooldown clear successful when its refresh is superseded", async () => {
    const { controller, cooldown, refresh, setMessage } = createHarness();
    refresh.mockRejectedValueOnce(new Error("Provider refresh was superseded"));

    const run = controller.mutate(
      "profiles:openai",
      "models.authCooldownClear",
      { provider: "openai", profileId: "openai:one" },
      "Available",
      "cooldown:openai",
    );
    cooldown.resolve({});
    await run;

    expect(setMessage).toHaveBeenLastCalledWith("profiles:openai", {
      kind: "success",
      text: "Available",
      warning: "Provider refresh was superseded",
    });
  });

  it("keeps an acknowledged logout successful when its status refresh fails", async () => {
    const { controller, refresh, setMessage } = createHarness();
    refresh.mockRejectedValueOnce(new Error("gateway disconnected"));

    await controller.logout("openai", "openai", "openai", "openai:one", "Signed out");

    expect(setMessage).toHaveBeenLastCalledWith("profiles:openai", {
      kind: "success",
      text: "Signed out",
      warning: "gateway disconnected",
    });
  });

  it("warns without claiming a saved order failed when its status refresh fails", async () => {
    const { controller, order, refresh, setMessage } = createHarness();
    refresh.mockRejectedValueOnce(new Error("gateway disconnected"));

    controller.queue("openai", ["openai:two", "openai:one"]);
    order.resolve({});
    await controller.waitFor("openai");

    expect(setMessage).toHaveBeenLastCalledWith("profiles:openai", {
      kind: "warning",
      text: "gateway disconnected",
    });
  });

  it.each(["order", "cooldown"] as const)(
    "keeps the owner busy when %s finishes before the overlapping mutation",
    async (first) => {
      const { busy, controller, cooldown, order, request } = createHarness();
      const cooldownRun = controller.mutate(
        "profiles:openai",
        "models.authCooldownClear",
        { provider: "openai", profileId: "openai:one" },
        "Available",
        "cooldown:openai",
      );
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("models.authCooldownClear", {
          provider: "openai",
          profileId: "openai:one",
          agentId: "main",
        }),
      );

      controller.queue("openai", ["openai:two", "openai:one"]);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "models.authOrderSet",
          expect.objectContaining({ provider: "openai" }),
        ),
      );

      if (first === "order") {
        order.resolve({});
        await controller.waitFor("openai");
        expect(busy["cooldown:openai"]).toBe(true);
        cooldown.resolve({});
        await cooldownRun;
      } else {
        cooldown.resolve({});
        await cooldownRun;
        expect(busy["profiles:openai"]).toBe(true);
        order.resolve({});
        await controller.waitFor("openai");
      }
      expect(busy["profiles:openai"]).toBe(false);
      expect(busy["cooldown:openai"]).toBe(false);
    },
  );

  it("refreshes the authoritative order after the final queued save fails", async () => {
    const { controller, order, refresh, request } = createHarness();

    controller.queue("openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "models.authOrderSet",
        expect.objectContaining({ provider: "openai" }),
      ),
    );
    order.reject(new Error("profile order changed; refresh and retry"));
    await controller.waitFor("openai");

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("refreshes an ambiguous save before sending the latest queued order", async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const { controller, refresh, request, setAuthoritativeOrder } = createHarness();
    request
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    refresh.mockImplementationOnce(async () => {
      setAuthoritativeOrder(["openai:two", "openai:one"]);
    });

    controller.queue("openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.queue("openai", ["openai:one", "openai:two"]);
    first.reject(new Error("gateway response lost"));

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalledOnce();
    expect(request).toHaveBeenLastCalledWith("models.authOrderSet", {
      provider: "openai",
      profileIds: ["openai:one", "openai:two"],
      expectedProfileIds: ["openai:two", "openai:one"],
      expectedProfileMembership: ["openai:one", "openai:two"],
      agentId: "main",
    });
    second.resolve({});
    await controller.waitFor("openai");
  });

  it("retries a queued order against membership loaded by the recovery refresh", async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const { controller, getData, refresh, request, setAuthoritativeOrder } = createHarness();
    request
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    refresh.mockImplementationOnce(async () => {
      const data = getData();
      const provider = data.authStatus?.providers[0];
      if (!provider) {
        throw new Error("auth provider missing");
      }
      provider.profiles.push({ profileId: "openai:three", type: "oauth", status: "ok" });
      setAuthoritativeOrder(["openai:three", "openai:two", "openai:one"]);
      controller.applyData(data);
    });

    controller.queue("openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.queue("openai", ["openai:one", "openai:two"]);
    first.reject(new Error("profile membership changed"));

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith(
      "models.authOrderSet",
      expect.objectContaining({
        profileIds: ["openai:three", "openai:one", "openai:two"],
        expectedProfileMembership: ["openai:one", "openai:two", "openai:three"],
      }),
    );
    second.resolve({});
    await controller.waitFor("openai");
  });

  it("keeps an ambiguous draft offline and retries it after fresh data arrives", async () => {
    const failed = createDeferred<unknown>();
    const retry = createDeferred<unknown>();
    const { controller, getData, refresh, request } = createHarness();
    request
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => retry.promise);
    refresh.mockRejectedValueOnce(new Error("gateway disconnected"));

    controller.queue("openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    failed.reject(new Error("gateway response lost"));
    await controller.waitFor("openai");

    expect(request).toHaveBeenCalledTimes(1);
    controller.applyData(getData());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith(
      "models.authOrderSet",
      expect.objectContaining({
        provider: "openai",
        profileIds: ["openai:two", "openai:one"],
      }),
    );
    retry.resolve({});
    await controller.waitFor("openai");
  });
});
