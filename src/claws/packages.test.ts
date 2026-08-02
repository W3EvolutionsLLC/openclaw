import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PluginInstallCommandFailure } from "../cli/plugins-install-command.js";
import type { InstallPolicyWarning } from "../plugins/install-security-scan.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install-types.js";
import { installClawPackages, preflightClawPackage } from "./packages.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import type { ClawAddPlan, ResolvedClawPackage } from "./types.js";

function plan(
  packages: ResolvedClawPackage[],
  ownerAction: "install" | "reuse" = "install",
): ClawAddPlan {
  return {
    schemaVersion: "openclaw.clawAddPlan.v1",
    manifestSchemaVersion: 1,
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:plan",
    claw: {
      kind: "package",
      name: "incident-claw",
      version: "1.0.0",
      packageRoot: "/tmp/claw",
      manifestPath: "/tmp/claw/claw.json",
      integrityKind: "artifact",
      integrity: "sha256:claw",
      byteLength: 123,
    },
    agent: {
      requestedId: "incident",
      finalId: "incident-2",
      workspace: "/tmp/incident-2",
      config: { id: "incident-2", workspace: "/tmp/incident-2" },
    },
    summary: {
      totalActions: packages.length,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: packages.length,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    capabilityChanges: [],
    actions: packages.map((pkg) => ({
      kind: "package",
      id: `${pkg.kind}:${pkg.ref}`,
      action: "install",
      target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
      details: {
        ...pkg,
        ownerAction,
        ...(pkg.kind === "plugin" ? { installId: pkg.ref.split("/").at(-1) } : {}),
      },
      blocked: false,
    })),
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const pluginPackage = {
  kind: "plugin",
  source: "clawhub",
  ref: "@owner/audit",
  version: "2.0.1",
  integrity,
} as const;

const completePackageRef = vi.fn(
  (ref: PersistedClawPackageRef, status: PersistedClawPackageRef["status"]) => ({
    ...ref,
    status,
  }),
);
const pluginIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function pluginPackageRef(
  ref: string,
  overrides: Partial<PersistedClawPackageRef> = {},
): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "incident-2",
    clawName: "incident-claw",
    kind: "plugin",
    source: "clawhub",
    ref,
    version: "1.0.0",
    integrity: pluginIntegrity,
    status: "complete",
    relationship: "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1_000,
    updatedAtMs: 2_000,
    ...overrides,
  };
}
const acquirePackageLease = vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() }));
const probePlugin = vi.fn(async ({ spec }: { spec: string }) => {
  const pluginId = spec.slice(spec.lastIndexOf("/") + 1).split("@")[0]!;
  const packageName = spec.replace(/^clawhub:/, "").replace(/@[^@]+$/, "");
  return {
    ok: true as const,
    pluginId,
    packageName,
    targetDir: "/tmp/plugin",
    extensions: [],
    clawhub: {
      source: "clawhub" as const,
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: packageName,
      clawhubFamily: "code-plugin" as const,
      integrity,
    },
  };
});

describe("preflightClawPackage plugin setup requirements", () => {
  const setup = {
    providers: [
      {
        id: "evidence",
        authMethods: ["api-key"],
        envVars: ["EVIDENCE_API_KEY", "EVIDENCE_TOKEN"],
      },
    ],
  };
  const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "install" });
  const probePluginSetup = vi.fn().mockResolvedValue({
    ok: true,
    pluginId: "evidence",
    setup,
    clawhub: { integrity },
  });

  it("reports plugin setup when no declared environment credential is present", async () => {
    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: {},
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        requirements: [
          {
            kind: "plugin-setup",
            plugin: "evidence",
            provider: "evidence",
            envVars: ["EVIDENCE_API_KEY", "EVIDENCE_TOKEN"],
            authMethods: ["api-key"],
          },
        ],
      }),
    );
  });

  it("accepts any declared environment credential", async () => {
    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: { EVIDENCE_TOKEN: "configured" },
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("accepts credentials for any declared provider", async () => {
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [
          { id: "first", envVars: ["FIRST_API_KEY"] },
          { id: "second", envVars: ["SECOND_API_KEY"] },
        ],
      },
      clawhub: { integrity },
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: { SECOND_API_KEY: "configured" },
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("does not gate readiness on an auth-method-only provider", async () => {
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [{ id: "oauth-only", authMethods: ["oauth"] }],
      },
      clawhub: { integrity },
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: {},
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("keeps a dry-run policy warning in the plan without making it a blocker", async () => {
    const warning: InstallPolicyWarning = {
      reason: "Plugin source needs review.",
      acknowledgementId: `v1:${"a".repeat(43)}`,
    };
    const probePluginWarning = vi.fn(
      async (
        params: Parameters<typeof import("../plugins/clawhub.js").installPluginFromClawHub>[0],
      ) => {
        expect(params.dryRun).toBe(true);
        expect(await params.onInstallPolicyWarning?.(warning)).toBe(true);
        return {
          ok: true as const,
          pluginId: "evidence",
          packageName: "@owner/audit",
          targetDir: "/tmp/plugin",
          extensions: [],
          setup,
          clawhub: {
            source: "clawhub" as const,
            clawhubUrl: "https://clawhub.ai",
            clawhubPackage: "@owner/audit",
            clawhubFamily: "code-plugin" as const,
            integrity,
          },
        };
      },
    );

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: {},
        deps: { preflightPlugin, probePlugin: probePluginWarning },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        installPolicyWarning: warning,
      }),
    );
  });

  it("keeps a dry-run policy warning on an expected installed-version conflict", async () => {
    const warning: InstallPolicyWarning = {
      reason: "Plugin update needs review.",
      acknowledgementId: `v1:${"b".repeat(43)}`,
    };
    const preflightPluginConflict = vi.fn().mockResolvedValue({
      ok: false,
      code: "plugin_version_conflict",
      installedVersion: "1.0.0",
    });
    const probePluginWarning = vi.fn(
      async (
        params: Parameters<typeof import("../plugins/clawhub.js").installPluginFromClawHub>[0],
      ) => {
        expect(await params.onInstallPolicyWarning?.(warning)).toBe(true);
        return {
          ok: true as const,
          pluginId: "evidence",
          packageName: "@owner/audit",
          targetDir: "/tmp/plugin",
          extensions: [],
          setup,
          clawhub: {
            source: "clawhub" as const,
            clawhubUrl: "https://clawhub.ai",
            clawhubPackage: "@owner/audit",
            clawhubFamily: "code-plugin" as const,
            integrity,
          },
        };
      },
    );

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: {},
        deps: { preflightPlugin: preflightPluginConflict, probePlugin: probePluginWarning },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: "plugin_version_conflict",
        installPolicyWarning: warning,
      }),
    );
  });

  it("accepts declared local auth evidence", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "claw-auth-evidence-"));
    const credentialsPath = join(credentialsDir, "credentials.json");
    await writeFile(credentialsPath, "{}", "utf8");
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [
          {
            ...setup.providers[0],
            authEvidence: [
              {
                type: "local-file-with-env",
                fileEnvVar: "EVIDENCE_CREDENTIALS",
                requiresAllEnv: ["EVIDENCE_PROJECT"],
                credentialMarker: "evidence-local-credentials",
              },
            ],
          },
        ],
      },
      clawhub: { integrity },
    });

    try {
      await expect(
        preflightClawPackage(pluginPackage, "/tmp/workspace", {
          env: {
            EVIDENCE_CREDENTIALS: credentialsPath,
            EVIDENCE_PROJECT: "project",
          },
          deps: { preflightPlugin, probePlugin: probePluginSetup },
        }),
      ).resolves.not.toHaveProperty("requirements");
    } finally {
      await rm(credentialsDir, { recursive: true, force: true });
    }
  });
});

describe("installClawPackages", () => {
  it("installs skill packages into the planned workspace with the resolved digest", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const pending = {
      kind: "skill",
      ref: "@owner/triage",
      status: "pending",
      integrity: skillIntegrity,
    };
    const installSkill = vi.fn().mockResolvedValue({
      ok: true,
      slug: "triage",
      version: "1.2.3",
      targetDir: "/tmp/incident-2/skills/triage",
    });
    const persistPackageRef = vi.fn().mockReturnValue(pending);
    const onExternalMutation = vi.fn();
    const onInstallPolicyWarning = vi.fn(async () => true);

    await installClawPackages(
      plan([
        {
          kind: "skill",
          source: "clawhub",
          ref: "@owner/triage",
          version: "1.2.3",
          integrity: skillIntegrity,
        },
      ]),
      {
        deps: {
          installSkill,
          preflightSkill: vi
            .fn()
            .mockResolvedValue({ ok: true, action: "install", integrity: skillIntegrity }),
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
        onExternalMutation,
        onInstallPolicyWarning,
      },
    );

    expect(installSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/incident-2",
        slug: "@owner/triage",
        version: "1.2.3",
        expectedIntegrity: skillIntegrity,
        clawManaged: true,
        onInstallPolicyWarning,
      }),
    );
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ integrity: skillIntegrity }),
      expect.objectContaining({
        status: "pending",
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
    expect(onExternalMutation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "skill", ref: "@owner/triage" }),
    );
  });

  it("installs plugins through the shared plugin surface", async () => {
    const installPlugin = vi.fn().mockResolvedValue(undefined);
    const persistPackageRef = vi.fn().mockReturnValue({
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    });
    const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "install" });
    const onInstallPolicyWarning = vi.fn(async () => true);

    await installClawPackages(plan([pluginPackage]), {
      deps: {
        installPlugin,
        probePlugin,
        preflightPlugin,
        persistPackageRef,
        completePackageRef,
        acquirePackageLease,
      },
      onInstallPolicyWarning,
    });

    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "clawhub:@owner/audit@2.0.1",
        opts: {
          acknowledgeClawHubRisk: true,
          expectedIntegrity:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          expectedPluginId: "audit",
          onInstallPolicyWarning,
        },
        invalidateRuntimeCache: false,
        clawManaged: true,
      }),
    );
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      expect.objectContaining({
        status: "pending",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
    expect(probePlugin).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dryRun: true,
        onInstallPolicyWarning: expect.any(Function),
      }),
    );
  });

  it("does not report a declined plugin policy warning as an external mutation", async () => {
    const onExternalMutation = vi.fn();
    const installPlugin = vi
      .fn()
      .mockRejectedValue(
        new PluginInstallCommandFailure(
          "install policy warning requires acknowledgement",
          PLUGIN_INSTALL_ERROR_CODE.INSTALL_POLICY_ACKNOWLEDGEMENT_REQUIRED,
        ),
      );

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin,
          probePlugin,
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef: vi.fn().mockReturnValue({
            kind: "plugin",
            ref: "@owner/audit",
            status: "pending",
            integrity,
          }),
          completePackageRef,
          acquirePackageLease,
        },
        onExternalMutation,
        onInstallPolicyWarning: vi.fn(async () => false),
      }),
    ).rejects.toThrow("install policy warning requires acknowledgement");
    expect(onExternalMutation).not.toHaveBeenCalled();
  });

  it("does not report a terminal skill policy re-evaluation as an external mutation", async () => {
    const onExternalMutation = vi.fn();
    const installSkill = vi.fn().mockResolvedValue({
      ok: false,
      error: "blocked by install policy after acknowledgement",
      installPolicyFailure: true,
    });
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;

    await expect(
      installClawPackages(
        plan([
          {
            kind: "skill",
            source: "clawhub",
            ref: "@owner/triage",
            version: "1.2.3",
            integrity: skillIntegrity,
          },
        ]),
        {
          deps: {
            installSkill,
            preflightSkill: vi
              .fn()
              .mockResolvedValue({ ok: true, action: "install", integrity: skillIntegrity }),
            persistPackageRef: vi.fn().mockReturnValue({
              kind: "skill",
              ref: "@owner/triage",
              status: "pending",
              integrity: skillIntegrity,
            }),
            completePackageRef,
            acquirePackageLease,
          },
          onExternalMutation,
          onInstallPolicyWarning: vi.fn(async () => true),
        },
      ),
    ).rejects.toThrow("blocked by install policy after acknowledgement");

    expect(onExternalMutation).not.toHaveBeenCalled();
  });

  it("records a dependency ref without reinstalling an exact reused plugin", async () => {
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const preflightPlugin = vi.fn().mockResolvedValue({
      ok: true,
      action: "reuse",
      installedId: "audit",
      installedIntegrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    await installClawPackages(plan([pluginPackage], "reuse"), {
      deps: {
        installPlugin,
        probePlugin,
        preflightPlugin,
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([]),
        acquirePackageLease,
      },
    });

    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      expect.objectContaining({
        status: "complete",
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
      }),
    );
  });

  it("inherits Claw-introduced origin when another Claw already owns the plugin", async () => {
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const existing = {
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
    } as PersistedClawPackageRef;

    await installClawPackages(plan([pluginPackage], "reuse"), {
      deps: {
        installPlugin: vi.fn(),
        probePlugin,
        preflightPlugin: vi.fn().mockResolvedValue({
          ok: true,
          action: "reuse",
          installedId: "audit",
          installedIntegrity: integrity,
        }),
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([existing]),
        acquirePackageLease,
      },
    });

    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
  });

  it("preserves a newer independent plugin reinstall when another Claw reuses it", async () => {
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const existing = {
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
      updatedAtMs: 10,
    } as PersistedClawPackageRef;

    await installClawPackages(plan([pluginPackage], "reuse"), {
      deps: {
        installPlugin: vi.fn(),
        probePlugin,
        preflightPlugin: vi.fn().mockResolvedValue({
          ok: true,
          action: "reuse",
          installedId: "audit",
          installedIntegrity: integrity,
          installedAt: new Date(20).toISOString(),
        }),
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([existing]),
        acquirePackageLease,
      },
    });

    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
      }),
    );
  });

  it("marks the pending ref failed when a plugin install fails", async () => {
    const pending = {
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    } as PersistedClawPackageRef;
    const persistPackageRef = vi.fn().mockReturnValue(pending);

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
          probePlugin,
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [expect.objectContaining({ ref: "@owner/audit", status: "failed" })],
    });
  });

  it("removes a newly installed plugin when a later package fails", async () => {
    const rollbackIntegrity =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const installPlugin = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second install failed"));
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const refs = [
      pluginPackageRef("@owner/first", { status: "pending" }),
      pluginPackageRef("@owner/second", { status: "pending" }),
    ];
    const persistPackageRef = vi.fn().mockReturnValueOnce(refs[0]).mockReturnValueOnce(refs[1]);
    const readPackageRefs = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([pluginPackageRef("@owner/first")]);

    await expect(
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/first",
            version: "1.0.0",
            integrity: rollbackIntegrity,
          },
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/second",
            version: "1.0.0",
            integrity: rollbackIntegrity,
          },
        ]),
        {
          deps: {
            installPlugin,
            uninstallPlugin,
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef,
            completePackageRef,
            readPackageRefs,
            acquirePackageLease,
            resolvePlugin: vi.fn().mockResolvedValue({
              status: "found",
              pluginId: "first",
              installedVersion: "1.0.0",
              record: {
                source: "clawhub",
                integrity: rollbackIntegrity,
                installedAt: new Date(1_500).toISOString(),
              },
            }),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "package_install_failed", message: "second install failed" });

    expect(uninstallPlugin).toHaveBeenCalledWith(
      "first",
      { force: true, invalidateRuntimeCache: false, clawManaged: true },
      expect.anything(),
    );
    expect(completePackageRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "@owner/first" }),
      "rolled_back",
      expect.anything(),
    );
  });

  it("keeps a newly installed plugin when a direct owner claims it before rollback", async () => {
    const installPlugin = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second install failed"));
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const refs = [
      pluginPackageRef("@owner/first", { status: "pending" }),
      pluginPackageRef("@owner/second", { status: "pending" }),
    ];

    await expect(
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/first",
            version: "1.0.0",
            integrity: pluginIntegrity,
          },
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/second",
            version: "1.0.0",
            integrity: pluginIntegrity,
          },
        ]),
        {
          deps: {
            installPlugin,
            uninstallPlugin,
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef: vi.fn().mockReturnValueOnce(refs[0]).mockReturnValueOnce(refs[1]),
            completePackageRef,
            readPackageRefs: vi
              .fn()
              .mockReturnValueOnce([])
              .mockReturnValueOnce([pluginPackageRef("@owner/first", { independentOwner: true })]),
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "package_rollback_failed",
      message: expect.stringContaining("now has a direct owner"),
    });

    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it("preserves the installer error when failure provenance cannot be updated", async () => {
    const pending = {
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    } as PersistedClawPackageRef;
    const failingCompletePackageRef = vi.fn(() => {
      throw new Error("state database unavailable");
    });

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
          probePlugin,
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef: vi.fn().mockReturnValue(pending),
          completePackageRef: failingCompletePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [pending],
    });
    expect(failingCompletePackageRef).toHaveBeenCalledWith(pending, "failed", expect.anything());
  });

  it("invalidates consent when plugin owner state changes after planning", async () => {
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn();
    const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "reuse" });

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin,
          probePlugin,
          preflightPlugin,
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).not.toHaveBeenCalled();
  });

  it("invalidates consent when a skill trust warning changes after planning", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const planned = plan([
      {
        kind: "skill",
        source: "clawhub",
        ref: "@owner/triage",
        version: "1.2.3",
        integrity: skillIntegrity,
      },
    ]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        deps: {
          preflightSkill: vi.fn().mockResolvedValue({
            ok: true,
            action: "install",
            integrity: skillIntegrity,
            warning: "review warning two",
          }),
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });

  it("invalidates consent when a plugin trust warning changes after planning", async () => {
    const planned = plan([pluginPackage]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        deps: {
          probePlugin: vi.fn().mockResolvedValue({
            ok: true,
            pluginId: "audit",
            warning: "review warning two",
            clawhub: { integrity },
          }),
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });
});
