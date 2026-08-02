import { describe, expect, it, vi } from "vitest";
import { CLAW_UPDATE_PLAN_SCHEMA_VERSION, type ClawUpdatePlan } from "../claws/update-plan.js";
import { logClawUpdatePlanSummary } from "./claws-cli-update-output.js";
import { createCliRuntimeMock } from "./test-runtime-mock.js";

describe("logClawUpdatePlanSummary", () => {
  it("prints actionable install-policy warnings with safe terminal text", () => {
    const { defaultRuntime, runtimeLogs } = createCliRuntimeMock(vi);
    const plan: ClawUpdatePlan = {
      schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:update-plan",
      found: true,
      agentId: "demo-agent",
      summary: {
        totalActions: 1,
        added: 0,
        changed: 1,
        removed: 0,
        released: 0,
        unchanged: 0,
        manual: 0,
        blocked: 0,
        capabilityChanges: 0,
        capabilityEscalations: 0,
      },
      actions: [
        {
          kind: "package",
          id: "plugin:github",
          action: "change",
          target: "clawhub:github@2.0.0",
          blocked: false,
          reason: "target changes package version",
          installPolicyWarning: {
            acknowledgementId: `v1:${"w".repeat(43)}`,
            reason: "Review\u001b[31m plugin\nupdate.",
          },
        },
      ],
      capabilityChanges: [],
      blockers: [],
      diagnostics: [],
    };

    logClawUpdatePlanSummary(plan, defaultRuntime);

    const output = runtimeLogs.join("\n");
    expect(output).toContain("Install policy warnings (1):");
    expect(output).toContain("Review plugin\\nupdate.");
    expect(output).not.toContain("\u001b");
  });
});
