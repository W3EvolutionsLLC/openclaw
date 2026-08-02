import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  accumulateInstallPolicyWarningAcknowledgement,
  createInstallPolicyWarningAcknowledger,
} from "./install-security-scan.types.js";

const runInstallPolicyMock = vi.fn();
const findBlockedManifestDependenciesMock = vi.fn();
const findBlockedNodeModulesDirectoryMock = vi.fn();
const findBlockedNodeModulesFileAliasMock = vi.fn();
const findBlockedPackageDirectoryInPathMock = vi.fn();
const findBlockedPackageFileAliasInPathMock = vi.fn();
const getGlobalHookRunnerMock = vi.fn();

vi.mock("../security/install-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/install-policy.js")>();
  return {
    ...actual,
    runInstallPolicy: (...args: unknown[]) => runInstallPolicyMock(...args),
  };
});

vi.mock("./dependency-denylist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dependency-denylist.js")>();
  return {
    ...actual,
    findBlockedManifestDependencies: (...args: unknown[]) =>
      findBlockedManifestDependenciesMock(...args),
    findBlockedNodeModulesDirectory: (...args: unknown[]) =>
      findBlockedNodeModulesDirectoryMock(...args),
    findBlockedNodeModulesFileAlias: (...args: unknown[]) =>
      findBlockedNodeModulesFileAliasMock(...args),
    findBlockedPackageDirectoryInPath: (...args: unknown[]) =>
      findBlockedPackageDirectoryInPathMock(...args),
    findBlockedPackageFileAliasInPath: (...args: unknown[]) =>
      findBlockedPackageFileAliasInPathMock(...args),
  };
});

vi.mock("./hook-runner-global.js", () => ({
  getGlobalHookRunner: () => getGlobalHookRunnerMock(),
}));

const {
  evaluateSkillInstallPolicyRuntime,
  preflightPluginNpmInstallPolicyRuntime,
  scanBundleInstallSourceRuntime,
  scanFileInstallSourceRuntime,
  scanInstalledPackageDependencyTreeRuntime,
} = await import("./install-security-scan.runtime.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const WARNING_A_ID = `v1:${"a".repeat(43)}`;
const WARNING_B_ID = `v1:${"b".repeat(43)}`;

function expectOnlyOperatorPolicyRan() {
  expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  expect(findBlockedManifestDependenciesMock).not.toHaveBeenCalled();
  expect(findBlockedNodeModulesDirectoryMock).not.toHaveBeenCalled();
  expect(findBlockedNodeModulesFileAliasMock).not.toHaveBeenCalled();
  expect(findBlockedPackageDirectoryInPathMock).not.toHaveBeenCalled();
  expect(findBlockedPackageFileAliasInPathMock).not.toHaveBeenCalled();
  expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  runInstallPolicyMock.mockReset();
  findBlockedManifestDependenciesMock.mockReset();
  findBlockedNodeModulesDirectoryMock.mockReset();
  findBlockedNodeModulesFileAliasMock.mockReset();
  findBlockedPackageDirectoryInPathMock.mockReset();
  findBlockedPackageFileAliasInPathMock.mockReset();
  getGlobalHookRunnerMock.mockReset();
});

describe("install security scan official bypass", () => {
  it("accepts a Gateway acknowledgement only for the warning that issued it", async () => {
    const acknowledge = createInstallPolicyWarningAcknowledger(WARNING_A_ID);

    expect(await acknowledge?.({ reason: "review", acknowledgementId: WARNING_A_ID })).toBe(true);
    expect(await acknowledge?.({ reason: "review", acknowledgementId: WARNING_B_ID })).toBe(false);
    expect(createInstallPolicyWarningAcknowledger(undefined)).toBeUndefined();
  });

  it("carries earlier warning acknowledgements into the next Gateway retry token", async () => {
    const cumulativeWarning = accumulateInstallPolicyWarningAcknowledgement(WARNING_A_ID, {
      reason: "dependency tree needs review",
      acknowledgementId: WARNING_B_ID,
    });
    const acknowledge = createInstallPolicyWarningAcknowledger(cumulativeWarning.acknowledgementId);

    expect(cumulativeWarning.acknowledgementId).toBe(
      `${WARNING_A_ID}.${WARNING_B_ID.slice("v1:".length)}`,
    );
    expect(
      await acknowledge?.({ reason: "package needs review", acknowledgementId: WARNING_A_ID }),
    ).toBe(true);
    expect(
      await acknowledge?.({
        reason: "dependency tree needs review",
        acknowledgementId: WARNING_B_ID,
      }),
    ).toBe(true);
  });

  it("completes a retry after two different install stages warn", async () => {
    const packageDir = tempDirs.make("openclaw-install-policy-multiple-warnings-");
    const bundleWarning = { decision: "warn" as const, reason: "package needs review" };
    const dependencyWarning = {
      decision: "warn" as const,
      reason: "dependency tree needs review",
    };
    runInstallPolicyMock.mockResolvedValueOnce(bundleWarning);

    const firstBundleResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      sourceDir: packageDir,
    });
    const firstToken = firstBundleResult?.warning?.acknowledgementId;
    const acknowledgeFirst = createInstallPolicyWarningAcknowledger(firstToken);
    runInstallPolicyMock
      .mockResolvedValueOnce(bundleWarning)
      .mockResolvedValueOnce(bundleWarning)
      .mockResolvedValueOnce(dependencyWarning);

    expect(
      await scanBundleInstallSourceRuntime({
        onInstallPolicyWarning: acknowledgeFirst,
        logger: {},
        pluginId: "third-party",
        sourceDir: packageDir,
      }),
    ).toBeUndefined();
    const secondResult = await scanInstalledPackageDependencyTreeRuntime({
      onInstallPolicyWarning: acknowledgeFirst,
      logger: {},
      packageDir,
      pluginId: "third-party",
    });
    expect(secondResult?.warning).toBeDefined();
    if (!secondResult?.warning) {
      throw new Error("expected a dependency-tree warning");
    }
    const cumulativeWarning = accumulateInstallPolicyWarningAcknowledgement(
      firstToken,
      secondResult.warning,
    );
    const acknowledgeBoth = createInstallPolicyWarningAcknowledger(
      cumulativeWarning.acknowledgementId,
    );
    runInstallPolicyMock
      .mockResolvedValueOnce(bundleWarning)
      .mockResolvedValueOnce(bundleWarning)
      .mockResolvedValueOnce(dependencyWarning)
      .mockResolvedValueOnce(dependencyWarning);

    expect(
      await scanBundleInstallSourceRuntime({
        onInstallPolicyWarning: acknowledgeBoth,
        logger: {},
        pluginId: "third-party",
        sourceDir: packageDir,
      }),
    ).toBeUndefined();
    expect(
      await scanInstalledPackageDependencyTreeRuntime({
        onInstallPolicyWarning: acknowledgeBoth,
        logger: {},
        packageDir,
        pluginId: "third-party",
      }),
    ).toBeUndefined();
  });

  it("acknowledges a previously seen later-stage warning after earlier stages allow", async () => {
    const packageDir = tempDirs.make("openclaw-install-policy-acknowledgement-");
    const laterWarning = {
      decision: "warn" as const,
      reason: "dependency tree needs review",
    };
    runInstallPolicyMock
      .mockResolvedValueOnce({ decision: "allow" })
      .mockResolvedValueOnce(laterWarning);

    const firstBundleResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      sourceDir: packageDir,
    });
    const firstDependencyResult = await scanInstalledPackageDependencyTreeRuntime({
      logger: {},
      packageDir,
      pluginId: "third-party",
    });
    const acknowledgementId = firstDependencyResult?.warning?.acknowledgementId;
    expect(acknowledgementId).toMatch(/^v1:/);
    const onInstallPolicyWarning = createInstallPolicyWarningAcknowledger(acknowledgementId);

    runInstallPolicyMock
      .mockResolvedValueOnce({ decision: "allow" })
      .mockResolvedValueOnce(laterWarning)
      .mockResolvedValueOnce(laterWarning);
    const retryBundleResult = await scanBundleInstallSourceRuntime({
      onInstallPolicyWarning,
      logger: {},
      pluginId: "third-party",
      sourceDir: packageDir,
    });
    const retryDependencyResult = await scanInstalledPackageDependencyTreeRuntime({
      onInstallPolicyWarning,
      logger: {},
      packageDir,
      pluginId: "third-party",
    });

    expect(firstBundleResult).toBeUndefined();
    expect(firstDependencyResult).toEqual({
      warning: { reason: laterWarning.reason, acknowledgementId },
    });
    expect(retryBundleResult).toBeUndefined();
    expect(retryDependencyResult).toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(5);
  });

  it("does not let one warning token acknowledge a different later stage", async () => {
    const packageDir = tempDirs.make("openclaw-install-policy-acknowledgement-scope-");
    const bundleWarning = { decision: "warn" as const, reason: "package needs review" };
    const dependencyWarning = {
      decision: "warn" as const,
      reason: "dependency tree needs review",
    };
    runInstallPolicyMock.mockResolvedValueOnce(bundleWarning);

    const firstBundleResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      sourceDir: packageDir,
    });
    const acknowledgementId = firstBundleResult?.warning?.acknowledgementId;
    expect(acknowledgementId).toMatch(/^v1:/);
    const onInstallPolicyWarning = createInstallPolicyWarningAcknowledger(acknowledgementId);

    runInstallPolicyMock
      .mockResolvedValueOnce(bundleWarning)
      .mockResolvedValueOnce({ decision: "allow" })
      .mockResolvedValueOnce(dependencyWarning);
    const retryBundleResult = await scanBundleInstallSourceRuntime({
      onInstallPolicyWarning,
      logger: {},
      pluginId: "third-party",
      sourceDir: packageDir,
    });
    const dependencyResult = await scanInstalledPackageDependencyTreeRuntime({
      onInstallPolicyWarning,
      logger: {},
      packageDir,
      pluginId: "third-party",
    });

    expect(retryBundleResult).toBeUndefined();
    expect(dependencyResult).toEqual({
      warning: {
        reason: dependencyWarning.reason,
        acknowledgementId: expect.stringMatching(/^v1:/),
      },
    });
    expect(dependencyResult?.warning?.acknowledgementId).not.toBe(acknowledgementId);
  });

  it("keeps a warning token stable when only its extracted temp path changes", async () => {
    const firstPackageDir = tempDirs.make("openclaw-plugin-install-first-");
    const secondPackageDir = tempDirs.make("openclaw-plugin-install-second-");
    await Promise.all([
      fs.writeFile(path.join(firstPackageDir, "index.js"), "export const value = 1;\n"),
      fs.writeFile(path.join(secondPackageDir, "index.js"), "export const value = 1;\n"),
    ]);
    runInstallPolicyMock.mockImplementation(async ({ request }) => ({
      decision: "warn" as const,
      reason: `review ${request.sourcePath}`,
      findings: [
        {
          ruleId: "temporary-path",
          severity: "warn" as const,
          message: `scanner inspected ${request.sourcePath}`,
          file: path.join(request.sourcePath, "index.js"),
          evidence: `loaded from ${request.sourcePath}/index.js`,
        },
      ],
    }));

    const firstResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      requestedSpecifier: "/tmp/third-party.tgz",
      source: { kind: "archive", authority: "user", mutable: true, network: false },
      sourceDir: firstPackageDir,
    });
    const secondResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      requestedSpecifier: "/tmp/third-party.tgz",
      source: { kind: "archive", authority: "user", mutable: true, network: false },
      sourceDir: secondPackageDir,
    });
    const acknowledgedResult = await scanBundleInstallSourceRuntime({
      logger: {},
      onInstallPolicyWarning: createInstallPolicyWarningAcknowledger(
        firstResult?.warning?.acknowledgementId,
      ),
      pluginId: "third-party",
      requestedSpecifier: "/tmp/third-party.tgz",
      source: { kind: "archive", authority: "user", mutable: true, network: false },
      sourceDir: secondPackageDir,
    });

    expect(firstResult?.warning?.acknowledgementId).toBe(secondResult?.warning?.acknowledgementId);
    expect(firstResult?.warning?.findings?.[0]?.file).toBe(`${firstPackageDir}/index.js`);
    expect(secondResult?.warning?.findings?.[0]?.file).toBe(`${secondPackageDir}/index.js`);
    expect(acknowledgedResult).toBeUndefined();
  });

  it("keeps a warning token stable when policy findings change order", async () => {
    const packageDir = tempDirs.make("openclaw-install-policy-finding-order-");
    const findings = [
      {
        ruleId: "dangerous-exec",
        severity: "critical" as const,
        message: "launches an executable",
        file: "index.js",
        line: 12,
      },
      {
        ruleId: "network-access",
        severity: "warn" as const,
        message: "contacts an external host",
        file: "client.js",
        line: 7,
      },
    ];
    const warning = { decision: "warn" as const, reason: "manual review required" };
    runInstallPolicyMock
      .mockResolvedValueOnce({ ...warning, findings })
      .mockResolvedValueOnce({ ...warning, findings: findings.toReversed() })
      .mockResolvedValueOnce({ decision: "allow" });

    const firstResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      sourceDir: packageDir,
    });
    const acknowledgementId = firstResult?.warning?.acknowledgementId;
    const acknowledgedResult = await scanBundleInstallSourceRuntime({
      logger: {},
      onInstallPolicyWarning: createInstallPolicyWarningAcknowledger(acknowledgementId),
      pluginId: "third-party",
      sourceDir: packageDir,
    });

    expect(firstResult?.warning?.findings).toEqual(findings);
    expect(acknowledgedResult).toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(3);
  });

  it("changes a warning token when staged artifact bytes change", async () => {
    const packageDir = tempDirs.make("openclaw-plugin-install-mutated-");
    const source = { kind: "workspace", authority: "user", mutable: true, network: false } as const;
    runInstallPolicyMock.mockResolvedValue({ decision: "warn", reason: "review this source" });
    await fs.writeFile(path.join(packageDir, "index.js"), "export const value = 1;\n");

    const firstResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      source,
      sourceDir: packageDir,
    });
    await fs.writeFile(path.join(packageDir, "index.js"), "export const value = 2;\n");
    const secondResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      source,
      sourceDir: packageDir,
    });

    expect(firstResult?.warning?.acknowledgementId).not.toBe(
      secondResult?.warning?.acknowledgementId,
    );
  });

  it("scopes mutable local warning tokens to their logical source path", async () => {
    const firstPackageDir = tempDirs.make("openclaw-plugin-install-workspace-first-");
    const secondPackageDir = tempDirs.make("openclaw-plugin-install-workspace-second-");
    await Promise.all([
      fs.writeFile(path.join(firstPackageDir, "index.js"), "export const value = 1;\n"),
      fs.writeFile(path.join(secondPackageDir, "index.js"), "export const value = 1;\n"),
    ]);
    runInstallPolicyMock.mockResolvedValue({ decision: "warn", reason: "review this source" });
    const source = { kind: "workspace", authority: "user", mutable: true, network: false } as const;

    const firstResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      source,
      sourceDir: firstPackageDir,
    });
    const secondResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      source,
      sourceDir: secondPackageDir,
    });

    expect(firstResult?.warning?.acknowledgementId).not.toBe(
      secondResult?.warning?.acknowledgementId,
    );
  });

  it("bypasses plugin install friction for bundled OpenClaw sources", async () => {
    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "openclaw/kitchen-sink",
      sourceDir: "/tmp/openclaw-bundled-plugin",
      source: { kind: "bundled", authority: "openclaw", mutable: false, network: false },
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("bypasses plugin install friction for official ClawHub sources", async () => {
    const result = await scanBundleInstallSourceRuntime({
      onInstallPolicyWarning: async () => true,
      logger: {},
      pluginId: "@openclaw/matrix",
      sourceDir: "/tmp/openclaw-official-clawhub-plugin",
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("bypasses skill install friction for bundled OpenClaw sources", async () => {
    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: {
        type: "openclaw-bundled",
        skillName: "peekaboo",
        installId: "node",
      },
      source: { kind: "bundled", authority: "openclaw", mutable: false, network: false },
      skillName: "peekaboo",
      sourceDir: "/tmp/openclaw-bundled-skill/peekaboo",
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("keeps immutable ClawHub skill warning tokens stable across extraction directories", async () => {
    const firstDir = tempDirs.make("openclaw-skill-policy-first-");
    const secondDir = tempDirs.make("openclaw-skill-policy-second-");
    await fs.writeFile(path.join(firstDir, "SKILL.md"), "# Review me\n", "utf8");
    await fs.writeFile(path.join(secondDir, "SKILL.md"), "# Review me\n", "utf8");
    const warning = { decision: "warn" as const, reason: "skill needs review" };
    runInstallPolicyMock.mockResolvedValueOnce(warning).mockResolvedValueOnce(warning);
    const common = {
      installId: "clawhub",
      logger: {},
      origin: {
        type: "clawhub" as const,
        registry: "https://clawhub.ai",
        slug: "review-me",
        version: "1.0.0",
      },
      requestedSpecifier: "clawhub:review-me@1.0.0",
      source: {
        kind: "clawhub" as const,
        authority: "openclaw" as const,
        mutable: false,
        network: true,
      },
      skillName: "review-me",
    };

    const first = await evaluateSkillInstallPolicyRuntime({ ...common, sourceDir: firstDir });
    const second = await evaluateSkillInstallPolicyRuntime({ ...common, sourceDir: secondDir });

    expect(first?.warning?.acknowledgementId).toMatch(/^v1:/);
    expect(second?.warning?.acknowledgementId).toBe(first?.warning?.acknowledgementId);
  });

  it("runs only operator policy for official immutable npm sources", async () => {
    const result = await preflightPluginNpmInstallPolicyRuntime({
      logger: {},
      packageName: "@openclaw/matrix",
      requestedSpecifier: "@openclaw/matrix@latest",
      source: { kind: "npm", authority: "official", mutable: false, network: true },
      sourcePath: "/tmp/openclaw-official-npm",
      sourcePathKind: "directory",
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("does not let warning acknowledgement override an operator block", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      decision: "block",
      code: "security_scan_blocked",
      reason: "blocked by operator policy",
    });

    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "@openclaw/matrix",
      sourceDir: "/tmp/openclaw-official-clawhub-plugin",
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expectOnlyOperatorPolicyRan();
  });

  it("still runs install policy for mutable workspace skill sources", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      decision: "block",
      code: "security_scan_blocked",
      reason: "blocked by operator policy",
    });

    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: {
        type: "workspace",
        skillName: "local-skill",
        installId: "node",
      },
      source: { kind: "workspace", authority: "user", mutable: true, network: false },
      skillName: "local-skill",
      sourceDir: "/tmp/local-skill",
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("returns an operator warning until the request acknowledges it", async () => {
    const packageDir = tempDirs.make("openclaw-plugin-install-warning-");
    const warning = {
      decision: "warn",
      reason: "scanner found risky behavior",
      findings: [
        {
          ruleId: "dangerous-exec",
          severity: "warn",
          message: "The package launches a child process.",
        },
      ],
    };
    runInstallPolicyMock.mockResolvedValue(warning);

    const firstResult = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "third-party",
      source: { kind: "npm", authority: "official", mutable: false, network: true },
      sourceDir: packageDir,
    });
    const acknowledgedResult = await scanBundleInstallSourceRuntime({
      onInstallPolicyWarning: async () => true,
      logger: {},
      pluginId: "third-party",
      source: { kind: "npm", authority: "official", mutable: false, network: true },
      sourceDir: packageDir,
    });

    expect(firstResult).toEqual({
      warning: {
        reason: "scanner found risky behavior",
        findings: warning.findings,
        acknowledgementId: expect.stringMatching(/^v1:/),
      },
    });
    expect(acknowledgedResult).toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(3);
  });

  it("sanitizes policy-controlled warning logs while preserving structured details", async () => {
    const packageDir = tempDirs.make("openclaw-plugin-install-sanitized-warning-");
    const warnings: string[] = [];
    const reason = "scanner says \u001b[31mdanger\u001b[0m\nreview required";
    const findings = [
      {
        ruleId: "dangerous-exec",
        severity: "warn" as const,
        message: "launches \u001b[2Jprocess\nwith shell",
        file: "plugin\u001b[31m.js",
        line: 7,
      },
    ];
    runInstallPolicyMock.mockResolvedValue({ decision: "warn", reason, findings });

    const result = await scanBundleInstallSourceRuntime({
      logger: { warn: (message) => warnings.push(message) },
      pluginId: "third-party",
      source: { kind: "npm", authority: "official", mutable: false, network: true },
      sourceDir: packageDir,
    });

    expect(result).toEqual({
      warning: { reason, findings, acknowledgementId: expect.stringMatching(/^v1:/) },
    });
    expect(warnings).toEqual([
      "Install policy: launches process\\nwith shell (plugin.js:7)",
      "Install policy warning: scanner says danger\\nreview required",
    ]);
  });

  it("reruns policy after interactive acknowledgement", async () => {
    const packageDir = tempDirs.make("openclaw-plugin-install-interactive-warning-");
    runInstallPolicyMock.mockResolvedValue({
      decision: "warn",
      reason: "scanner found risky behavior",
    });
    const onInstallPolicyWarning = vi.fn().mockResolvedValue(true);

    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      onInstallPolicyWarning,
      pluginId: "third-party",
      source: { kind: "npm", authority: "official", mutable: false, network: true },
      sourceDir: packageDir,
    });

    expect(result).toBeUndefined();
    expect(onInstallPolicyWarning).toHaveBeenCalledWith({
      reason: "scanner found risky behavior",
      acknowledgementId: expect.stringMatching(/^v1:/),
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
  });

  it("does not let interactive acknowledgement override a block returned on rerun", async () => {
    const packageDir = tempDirs.make("openclaw-plugin-install-warning-rerun-block-");
    runInstallPolicyMock
      .mockResolvedValueOnce({
        decision: "warn",
        reason: "scanner found risky behavior",
      })
      .mockResolvedValueOnce({
        decision: "block",
        code: "security_scan_blocked",
        reason: "blocked after operator review",
      });

    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      onInstallPolicyWarning: vi.fn().mockResolvedValue(true),
      pluginId: "third-party",
      source: { kind: "npm", authority: "official", mutable: false, network: true },
      sourceDir: packageDir,
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked after operator review",
      },
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
  });

  it("returns operator warnings from the post-resolution dependency-tree scan", async () => {
    const packageDir = tempDirs.make("openclaw-install-policy-dependency-tree-");
    runInstallPolicyMock.mockResolvedValue({
      decision: "warn",
      reason: "resolved dependencies need review",
    });

    const result = await scanInstalledPackageDependencyTreeRuntime({
      logger: {},
      packageDir,
      pluginId: "third-party",
    });

    expect(result).toEqual({
      warning: {
        reason: "resolved dependencies need review",
        acknowledgementId: expect.stringMatching(/^v1:/),
      },
    });
    expect(runInstallPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          origin: { type: "plugin-dependency-tree" },
        }),
      }),
    );
  });
});

describe("installed dependency tree scan", () => {
  it("accepts a managed host link declared as a runtime dependency", async () => {
    findBlockedManifestDependenciesMock.mockReturnValue([]);
    const npmRoot = tempDirs.make("openclaw-install-scan-");
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    const hostLink = path.join(packageDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(hostLink), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "runtime-plugin",
        dependencies: { openclaw: "2026.7.1" },
      }),
      "utf8",
    );
    await fs.symlink(process.cwd(), hostLink, "junction");

    const result = await scanInstalledPackageDependencyTreeRuntime({
      allowManagedNpmRootPackagePeerSymlinks: true,
      dependencyScanRootDir: npmRoot,
      logger: {},
      packageDir,
      pluginId: "runtime-plugin",
    });

    expect(result).toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a warning for a managed dependency tree with the trusted host link", async () => {
    findBlockedManifestDependenciesMock.mockReturnValue([]);
    const npmRoot = tempDirs.make("openclaw-install-policy-managed-host-link-");
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    const hostLink = path.join(packageDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(hostLink), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "runtime-plugin",
        dependencies: { openclaw: "2026.7.1" },
      }),
      "utf8",
    );
    await fs.symlink(process.cwd(), hostLink, "junction");
    runInstallPolicyMock.mockResolvedValue({
      decision: "warn",
      reason: "resolved dependencies need review",
    });

    const first = await scanInstalledPackageDependencyTreeRuntime({
      allowManagedNpmRootPackagePeerSymlinks: true,
      dependencyScanRootDir: npmRoot,
      logger: {},
      packageDir,
      pluginId: "runtime-plugin",
    });
    const acknowledgementId = first?.warning?.acknowledgementId;
    expect(acknowledgementId).toMatch(/^v1:/);

    const second = await scanInstalledPackageDependencyTreeRuntime({
      allowManagedNpmRootPackagePeerSymlinks: true,
      dependencyScanRootDir: npmRoot,
      logger: {},
      onInstallPolicyWarning: createInstallPolicyWarningAcknowledger(acknowledgementId),
      packageDir,
      pluginId: "runtime-plugin",
    });

    expect(second).toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(3);
  });

  it("rejects an openclaw dependency symlink that does not target the trusted host", async () => {
    findBlockedManifestDependenciesMock.mockReturnValue([]);
    const npmRoot = tempDirs.make("openclaw-install-scan-");
    const outsideRoot = tempDirs.make("openclaw-install-outside-");
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    const hostLink = path.join(packageDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(hostLink), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "runtime-plugin",
        dependencies: { openclaw: "2026.7.1" },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(outsideRoot, "package.json"), '{"name":"openclaw"}', "utf8");
    await fs.symlink(outsideRoot, hostLink, "junction");

    await expect(
      scanInstalledPackageDependencyTreeRuntime({
        allowManagedNpmRootPackagePeerSymlinks: true,
        dependencyScanRootDir: npmRoot,
        logger: {},
        packageDir,
        pluginId: "runtime-plugin",
      }),
    ).rejects.toThrow("installed dependency scan found package outside install root");
  });
});

describe("legacy file install scan compatibility", () => {
  it("preserves policy and hook metadata for published lazy install chunks", async () => {
    const warnings: string[] = [];
    const hasHooks = vi.fn().mockReturnValue(true);
    const runBeforeInstall = vi.fn().mockResolvedValue(undefined);
    getGlobalHookRunnerMock.mockReturnValue({ hasHooks, runBeforeInstall });
    runInstallPolicyMock.mockResolvedValueOnce({
      decision: "allow",
      findings: [
        {
          ruleId: "registry-review",
          severity: "warn",
          message: "Registry requires review.",
        },
      ],
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: { warn: (message) => warnings.push(message) },
      mode: "update",
      pluginId: "payload",
      requestedSpecifier: "./payload.js",
    });

    expect(result).toBeUndefined();
    expect(warnings).toEqual(["Install policy: Registry requires review."]);
    expect(runInstallPolicyMock).toHaveBeenCalledWith({
      artifactDigest: expect.any(Function),
      config: undefined,
      logger: expect.any(Object),
      request: {
        targetName: "payload",
        targetType: "plugin",
        sourcePath: "/tmp/payload.js",
        sourcePathKind: "file",
        source: { kind: "file", authority: "user", mutable: true, network: false },
        origin: { type: "plugin-file" },
        request: {
          kind: "plugin-file",
          mode: "update",
          requestedSpecifier: "./payload.js",
        },
        plugin: {
          contentType: "file",
          pluginId: "payload",
          extensions: ["payload.js"],
        },
      },
    });
    expect(hasHooks).toHaveBeenCalledWith("before_install");
    expect(runBeforeInstall).toHaveBeenCalledWith(
      {
        targetName: "payload",
        targetType: "plugin",
        origin: "plugin-file",
        sourcePath: "/tmp/payload.js",
        sourcePathKind: "file",
        request: {
          kind: "plugin-file",
          mode: "update",
          requestedSpecifier: "./payload.js",
        },
        builtinScan: {
          status: "ok",
          scannedFiles: 0,
          critical: 0,
          warn: 0,
          info: 0,
          findings: [],
        },
        plugin: {
          contentType: "file",
          pluginId: "payload",
          extensions: ["payload.js"],
        },
      },
      {
        origin: "plugin-file",
        targetType: "plugin",
        requestKind: "plugin-file",
      },
    );
  });

  it("returns operator policy blocks before invoking hooks", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      decision: "block",
      code: "security_scan_blocked",
      reason: "blocked by operator policy",
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      pluginId: "payload",
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
  });
});
