import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isUpdatePlanToolEnabledForOpenClawTools } from "./openclaw-tools.registration.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";

describe("openclaw-tools update_plan gating", () => {
  it("keeps update_plan disabled by default", () => {
    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: {} as OpenClawConfig,
      }),
    ).toBe(false);
  });

  it("registers update_plan when explicitly enabled", () => {
    const config = {
      tools: {
        experimental: {
          planTool: true,
        },
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config,
      }),
    ).toBe(true);
    expect(createUpdatePlanTool().displaySummary).toBe("Track a short structured work plan.");
  });

  it("does not auto-enable update_plan without a configured custom harness", () => {
    const cfg = {
      agents: {
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "demo-provider",
        modelId: "demo-model",
      }),
    ).toBe(false);
  });

  it("auto-enables update_plan when the provider harness contract requests it", () => {
    const resolveHarnessContract = vi.fn(() => ({
      id: "demo",
      planToolDefault: true,
    }));
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            customHarness: "demo",
          },
        },
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "demo-provider",
        modelId: "demo-model",
        resolveHarnessContract,
      }),
    ).toBe(true);
    expect(resolveHarnessContract).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "demo-provider",
        context: expect.objectContaining({
          provider: "demo-provider",
          modelId: "demo-model",
          customHarnessId: "demo",
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      }),
    );
  });

  it("does not auto-enable update_plan when the provider does not resolve the harness", () => {
    const resolveHarnessContract = vi.fn(() => undefined);
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            customHarness: "demo",
          },
        },
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "demo-provider",
        modelId: "demo-model",
        resolveHarnessContract,
      }),
    ).toBe(false);
    expect(resolveHarnessContract).toHaveBeenCalledOnce();
  });

  it("lets explicit planTool false override custom harness auto-enable", () => {
    const resolveHarnessContract = vi.fn(() => ({
      id: "demo",
      planToolDefault: true,
    }));
    const cfg = {
      tools: {
        experimental: {
          planTool: false,
        },
      },
      agents: {
        defaults: {
          embeddedPi: {
            customHarness: "demo",
          },
        },
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "demo-provider",
        modelId: "demo-model",
        resolveHarnessContract,
      }),
    ).toBe(false);
    expect(resolveHarnessContract).not.toHaveBeenCalled();
  });

  it("resolves custom harness gating from explicit agentId when no session key is available", () => {
    const resolveHarnessContract = vi.fn(() => ({
      id: "demo",
      planToolDefault: true,
    }));
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            customHarness: false,
          },
        },
        list: [
          { id: "main" },
          {
            id: "research",
            embeddedPi: {
              customHarness: "demo",
            },
          },
        ],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentId: "research",
        modelProvider: "demo-provider",
        modelId: "demo-model",
        resolveHarnessContract,
      }),
    ).toBe(true);
    expect(resolveHarnessContract).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          customHarnessId: "demo",
          agentId: "research",
        }),
      }),
    );
  });

  it("applies per-agent overrides without leaking the contract to other agents", () => {
    const resolveHarnessContract = vi.fn(() => ({
      id: "demo",
      planToolDefault: true,
    }));
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            customHarness: "demo",
          },
        },
        list: [
          {
            id: "main",
            embeddedPi: {
              customHarness: false,
            },
          },
          {
            id: "research",
          },
        ],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentId: "main",
        modelProvider: "demo-provider",
        modelId: "demo-model",
        resolveHarnessContract,
      }),
    ).toBe(false);
    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentId: "research",
        modelProvider: "demo-provider",
        modelId: "demo-model",
        resolveHarnessContract,
      }),
    ).toBe(true);
    expect(resolveHarnessContract).toHaveBeenCalledOnce();
  });
});
