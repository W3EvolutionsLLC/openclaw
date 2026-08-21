import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/openclaw-performance-crabbox.sh");
const CONFIG = ".github/crabbox/openclaw-performance-untrusted.yaml";
const SCHEMA = ".github/crabbox/openclaw-performance-evidence.schema.json";
const WORKFLOW = ".github/workflows/openclaw-performance.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = tempDirs.make("openclaw-performance-crabbox-");
  const artifact = ".artifacts/kova/reports/mock-provider/report.json";
  const artifactPath = join(root, artifact);
  const payload = join(root, "payload.tar.gz");
  const evidence = join(root, "remote-evidence.json");
  const timing = join(root, "timing.json");
  const output = join(root, ".artifacts/performance-crabbox/evidence/mock-provider.json");
  const contents = Buffer.from('{"status":"ok"}\n');
  mkdirSync(join(root, ".artifacts/kova/reports/mock-provider"), { recursive: true });
  writeFileSync(artifactPath, contents);
  execFileSync("tar", ["-czf", payload, "-C", root, artifact]);
  writeFileSync(
    evidence,
    JSON.stringify({
      schemaVersion: 1,
      lane: "mock-provider",
      testedRef: "refs/pull/1/head",
      openclawSha: "a".repeat(40),
      kovaSha: "b".repeat(40),
      workflow: { sha: "c".repeat(40), runId: "123", runAttempt: "1" },
      crabbox: {
        commit: "8ba71f913bbe57285ae29af45ef0d8ec6712477d",
        version: "0.46.0+8ba71f913bbe",
      },
      command: {
        name: "mock-provider",
        argv: [
          "profile=diagnostic",
          "repeat=1",
          "contract=canonical",
          "include=scenario:fresh-install",
          "failOnRegression=false",
        ],
        exitCode: 0,
        startedAt: "2026-08-21T00:00:00Z",
        finishedAt: "2026-08-21T00:01:00Z",
      },
      isolation: {
        sutUser: "openclaw-sut",
        trustedHarnessRootOwned: true,
        noSudo: true,
        imdsBlocked: true,
        environmentClean: true,
        cachesEmptyBefore: true,
      },
      artifacts: [{ path: artifact, size: contents.length, sha256: sha256(contents) }],
      lease: { provider: "aws", market: "on-demand", cleanupPolicy: "always" },
    }),
  );
  writeFileSync(
    timing,
    JSON.stringify({ leaseId: "cbx_0123456789ab", leaseStopped: true, leaseStopError: "" }),
  );
  return { artifact, evidence, output, payload, root, timing };
}

function verify(
  files: ReturnType<typeof fixture>,
  overrides: { evidence?: string; timing?: string } = {},
) {
  return spawnSync(
    "bash",
    [
      SCRIPT,
      "verify",
      "mock-provider",
      overrides.timing ?? files.timing,
      overrides.evidence ?? files.evidence,
      files.payload,
      files.output,
    ],
    { cwd: files.root, encoding: "utf8" },
  );
}

describe("OpenClaw performance Crabbox boundary", () => {
  it("uses dedicated AWS on-demand leases with no caches or forwarded environment", () => {
    const config = parse(readFileSync(CONFIG, "utf8")) as {
      provider?: string;
      capacity?: { market?: string };
      cache?: Record<string, boolean>;
      env?: { allow?: string[] };
      sync?: { gitSeed?: boolean; fingerprint?: boolean; include?: string[] };
    };

    expect(config.provider).toBe("aws");
    expect(config.capacity?.market).toBe("on-demand");
    expect(config.cache).toMatchObject({
      pnpm: false,
      npm: false,
      docker: false,
      git: false,
      purgeOnRelease: true,
    });
    expect(config.env?.allow).toEqual(["OPENCLAW_PERFORMANCE_NO_ENV"]);
    expect(config.sync).toMatchObject({ gitSeed: false, fingerprint: false });
    expect(config.sync?.include).toEqual([SCHEMA, "scripts/openclaw-performance-crabbox.sh"]);
  });

  it("keeps candidate bytes off Actions runners and stops every lease", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const script = readFileSync(SCRIPT, "utf8");
    const parsed = parse(workflow) as {
      jobs: Record<
        string,
        {
          if?: string;
          steps?: Array<{
            name?: string;
            env?: Record<string, string>;
            uses?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
    };
    const kova = expectDefined(parsed.jobs.kova, "kova job");
    const sourcePerformance = expectDefined(
      parsed.jobs.source_performance,
      "source performance job",
    );
    const external = expectDefined(parsed.jobs.external_performance, "external performance job");
    const checkout = external.steps?.find(
      (step) => step.name === "Checkout trusted performance harness",
    );
    const checkouts = external.steps?.filter((step) => step.uses?.startsWith("actions/checkout@"));
    const secretSteps = external.steps?.filter((step) =>
      JSON.stringify(step.env ?? {}).includes("CRABBOX_COORDINATOR"),
    );

    expect(workflow).toContain("CRABBOX_COMMIT: 8ba71f913bbe57285ae29af45ef0d8ec6712477d");
    expect(workflow).toContain("external_required:");
    expect(workflow).toContain("if: needs.resolve_target.outputs.external_required == 'true'");
    expect(workflow).toContain("--stop-after always --timing-json --no-hydrate");
    expect(workflow).toContain(
      "CRABBOX_COORDINATOR: ${{ secrets.CRABBOX_COORDINATOR || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR }}",
    );
    expect(workflow).toContain(
      "CRABBOX_COORDINATOR_TOKEN: ${{ secrets.CRABBOX_COORDINATOR_TOKEN || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR_TOKEN }}",
    );
    expect(workflow).toContain(
      "if: ${{ success() && steps.lane.outputs.run == 'true' && matrix.lane != 'cleanup-probe' }}",
    );
    expect(workflow).not.toContain("Checkout target metadata");
    expect(workflow).not.toContain("TARGET_CHECKOUT_DIR");
    expect(kova.if).toBe("needs.resolve_target.outputs.external_required != 'true'");
    expect(sourcePerformance.if).toBe("needs.resolve_target.outputs.external_required != 'true'");
    expect(external.if).toBe("needs.resolve_target.outputs.external_required == 'true'");
    expect(checkout?.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(checkouts?.map((step) => step.with?.ref)).toEqual(["${{ github.workflow_sha }}"]);
    expect(secretSteps?.map((step) => step.name)).toEqual(["Run candidate in disposable Crabbox"]);
    expect(script).toContain('runuser -u "$SUT_USER" -- env -i');
    expect(script).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(script).toContain("iptables -I OUTPUT -m owner --uid-owner");
    expect(script).toContain('pkill -KILL -u "$uid"');
  });

  it("verifies tar paths, sizes, hashes, and lease cleanup before export", () => {
    const files = fixture();
    const result = verify(files);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(files.root, files.artifact), "utf8")).toBe('{"status":"ok"}\n');
    expect(JSON.parse(readFileSync(files.output, "utf8")).lease).toEqual({
      provider: "aws",
      market: "on-demand",
      cleanupPolicy: "always",
      id: "cbx_0123456789ab",
      stopped: true,
      stopError: "",
    });
  });

  it("rejects artifact hash drift", () => {
    const files = fixture();
    const evidence = JSON.parse(readFileSync(files.evidence, "utf8")) as {
      artifacts: Array<{ sha256: string }>;
    };
    expectDefined(evidence.artifacts[0], "artifact evidence").sha256 = "0".repeat(64);
    writeFileSync(files.evidence, JSON.stringify(evidence));

    const result = verify(files);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("payload hash mismatch");
  });

  it("rejects a lease that was not stopped", () => {
    const files = fixture();
    writeFileSync(
      files.timing,
      JSON.stringify({
        leaseId: "cbx_0123456789ab",
        leaseStopped: false,
        leaseStopError: "release failed",
      }),
    );

    const result = verify(files);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Crabbox did not prove lease cleanup");
  });

  it("keeps the evidence schema bound to immutable revisions and cleanup", () => {
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.required).toEqual(
      expect.arrayContaining(["openclawSha", "kovaSha", "workflow", "crabbox", "command", "lease"]),
    );
    expect(schema.properties).toHaveProperty("artifacts");
    expect(schema.properties).toHaveProperty("isolation");
  });
});
