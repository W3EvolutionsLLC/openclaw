import { describe, expect, it } from "vitest";
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

  it("does not auto-enable update_plan outside strict-agentic mode", () => {
    const cfg = {
      agents: {
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
      }),
    ).toBe(false);
  });

  it("auto-enables update_plan for strict-agentic agents", () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            executionContract: "strict-agentic",
          },
        },
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
      }),
    ).toBe(true);
  });
});
