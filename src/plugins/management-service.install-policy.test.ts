import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installPolicyScan: vi.fn(),
  persistInstall: vi.fn(),
}));

vi.mock("./install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-persistence.js")>()),
  persistPluginInstall: (...args: unknown[]) => mocks.persistInstall(...args),
}));

vi.mock("./install-security-scan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-security-scan.js")>()),
  scanBundleInstallSource: (...args: unknown[]) => mocks.installPolicyScan(...args),
}));

const { installManagedPluginSource } = await import("./management-service.js");

describe("plugin management install policy", () => {
  beforeEach(() => {
    mocks.installPolicyScan.mockReset().mockResolvedValue(undefined);
    mocks.persistInstall.mockReset();
  });

  it("runs operator policy before persisting bundled plugins", async () => {
    const snapshot = {
      baseHash: "base-hash",
      config: {},
      snapshot: {
        valid: true as const,
        parsed: {},
        path: "/tmp/openclaw.json",
        sourceConfig: {},
        hash: "base-hash",
      },
      writeOptions: {
        expectedConfigPath: "/tmp/openclaw.json",
        includeFileHashesForWrite: { "/tmp/plugins.json": "include-hash" },
        includeFileTargetsForWrite: { "/tmp/plugins.json": "/tmp/plugins.json" },
      },
    };
    const bundledSource = {
      pluginId: "bundled-demo",
      localPath: "/app/dist/extensions/bundled-demo",
      version: "1.2.3",
    };
    const warning = {
      reason: "Manual review recommended.",
      findings: [
        {
          ruleId: "dangerous-exec",
          severity: "warn" as const,
          message: "The plugin launches a child process.",
        },
      ],
    };
    mocks.installPolicyScan.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: "Blocked by operator policy.",
      },
    });

    const blocked = await installManagedPluginSource({
      request: {
        source: "bundled",
        rawSpec: "bundled-demo",
        bundledSource,
        mode: "update",
      },
      snapshot,
      safetyOverrides: { config: snapshot.config },
    });

    expect(blocked).toEqual({
      ok: false,
      error: "Blocked by operator policy.",
      code: "security_scan_blocked",
    });
    expect(mocks.persistInstall).not.toHaveBeenCalled();

    mocks.installPolicyScan.mockResolvedValueOnce({ warning });
    const needsAcknowledgement = await installManagedPluginSource({
      request: {
        source: "bundled",
        rawSpec: "bundled-demo",
        bundledSource,
        mode: "update",
      },
      snapshot,
      safetyOverrides: { config: snapshot.config },
    });

    expect(needsAcknowledgement).toEqual({
      ok: false,
      error: warning.reason,
      code: "install_policy_acknowledgement_required",
      installPolicyWarning: warning,
    });
    expect(mocks.persistInstall).not.toHaveBeenCalled();
    expect(mocks.installPolicyScan).toHaveBeenCalledWith(
      expect.objectContaining({
        config: snapshot.config,
        pluginId: "bundled-demo",
        sourceDir: bundledSource.localPath,
        requestedSpecifier: "bundled-demo",
        mode: "update",
        source: {
          kind: "bundled",
          authority: "openclaw",
          mutable: false,
          network: false,
        },
      }),
    );

    mocks.installPolicyScan.mockResolvedValueOnce(undefined);
    mocks.persistInstall.mockResolvedValueOnce(snapshot.config);
    const acknowledged = await installManagedPluginSource({
      request: {
        source: "bundled",
        rawSpec: "bundled-demo",
        bundledSource,
        mode: "update",
      },
      snapshot,
      safetyOverrides: {
        config: snapshot.config,
        onInstallPolicyWarning: async () => true,
      },
    });

    expect(acknowledged.ok).toBe(true);
    expect(mocks.installPolicyScan).toHaveBeenLastCalledWith(
      expect.objectContaining({ onInstallPolicyWarning: expect.any(Function) }),
    );
    expect(mocks.persistInstall).toHaveBeenCalledTimes(1);
  });
});
