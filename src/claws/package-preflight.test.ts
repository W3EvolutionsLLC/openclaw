import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createConfiguredClawPackagePreflight } from "./package-preflight.js";
import { preflightClawPackage } from "./packages.js";

describe("createConfiguredClawPackagePreflight", () => {
  it("uses the same configured policy snapshot for Claw planning and apply", async () => {
    const config: OpenClawConfig = { security: { installPolicy: { enabled: true } } };
    const preflight = vi.fn<typeof preflightClawPackage>().mockResolvedValue({
      ok: true,
      action: "install",
      integrity: `sha256:${"a".repeat(64)}`,
    });
    const configuredPreflight = createConfiguredClawPackagePreflight(config, preflight);
    const pkg = {
      kind: "skill" as const,
      source: "clawhub" as const,
      ref: "agentreceipt",
      version: "1.0.0",
    };

    await configuredPreflight(pkg, "/tmp/claw-workspace");
    await configuredPreflight(pkg, "/tmp/claw-workspace");

    expect(preflight).toHaveBeenNthCalledWith(1, pkg, "/tmp/claw-workspace", { config });
    expect(preflight).toHaveBeenNthCalledWith(2, pkg, "/tmp/claw-workspace", { config });
  });
});
