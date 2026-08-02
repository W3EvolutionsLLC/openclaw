import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Claw install-policy plan integrity", () => {
  it("keeps the fingerprint stable while preserving transient warning details", async () => {
    const root = tempDirs.make("openclaw-claw-policy-plan-");
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "reviewer" },
      packages: [{ kind: "skill", source: "clawhub", ref: "review-skill", version: "1.0.0" }],
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }
    const source: ClawSourceIdentity = {
      kind: "package",
      name: "review-claw",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "openclaw.claw.json"),
      integrityKind: "artifact",
      integrity: "sha256:claw",
      byteLength: 0,
    };
    const firstWarning = {
      acknowledgementId: `v1:${"w".repeat(43)}`,
      reason: "Review /tmp/openclaw-first/root before install.",
      findings: [
        {
          ruleId: "dangerous-exec",
          severity: "critical" as const,
          message: "launches an executable",
          file: "/tmp/openclaw-first/root/index.js",
        },
      ],
    };
    const secondWarning = {
      ...firstWarning,
      reason: "Review /tmp/openclaw-second/root before install.",
      findings: firstWarning.findings.map((finding) =>
        Object.assign({}, finding, {
          file: finding.file.replace("openclaw-first", "openclaw-second"),
        }),
      ),
    };
    const build = async (installPolicyWarning: typeof firstWarning) =>
      await buildClawAddPlan({
        manifest: parsed.manifest,
        source,
        context: {
          workspace: join(root, "workspace"),
          packagePreflight: async () => ({
            ok: true,
            action: "install",
            integrity: `sha256:${"a".repeat(64)}`,
            installPolicyWarning,
          }),
        },
      });

    const first = await build(firstWarning);
    const second = await build(secondWarning);

    expect(second.planIntegrity).toBe(first.planIntegrity);
    expect(
      second.actions.find((action) => action.kind === "package")?.details?.installPolicyWarning,
    ).toEqual(secondWarning);
  });
});
