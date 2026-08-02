// Source install tests cover installing skill sources from local and remote inputs.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { installSkillFromSource } from "./source-install.js";

async function writeSkill(dir: string, params: { name?: string; description?: string } = {}) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    [
      "---",
      `name: ${params.name ?? path.basename(dir)}`,
      `description: ${params.description ?? "A local skill"}`,
      "---",
      "",
      "# Skill",
      "",
    ].join("\n"),
  );
}

async function initGitSkillRepo(repoDir: string, name = "git-skill") {
  await writeSkill(repoDir, { name });
  await runCommandWithTimeout(["git", "init"], { cwd: repoDir, timeoutMs: 30_000 });
  await runCommandWithTimeout(["git", "add", "SKILL.md"], { cwd: repoDir, timeoutMs: 30_000 });
  const commit = await runCommandWithTimeout(
    [
      "git",
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-m",
      "add skill",
    ],
    { cwd: repoDir, timeoutMs: 30_000 },
  );
  if (commit.code !== 0) {
    throw new Error(commit.stderr || commit.stdout || "git commit failed");
  }
}

async function runGitOk(repoDir: string, args: string[]) {
  const result = await runCommandWithTimeout(["git", ...args], {
    cwd: repoDir,
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function writeCapturePolicyScript(root: string) {
  await fs.chmod(root, 0o700);
  const scriptPath = path.join(root, "capture-policy.cjs");
  await fs.writeFile(
    scriptPath,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(process.env.CAPTURE_PATH, input);",
      "  process.stdout.write(JSON.stringify({ protocolVersion: 1, decision: 'allow' }));",
      "});",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return scriptPath;
}

function capturePolicyConfig(params: { scriptPath: string; capturePath: string }) {
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: {
          source: "exec" as const,
          command: params.scriptPath,
          env: { CAPTURE_PATH: params.capturePath },
          trustedDirs: [path.dirname(params.scriptPath)],
        },
      },
    },
  };
}

async function writeDecisionPolicyScript(root: string): Promise<{
  scriptPath: string;
  countPath: string;
}> {
  await fs.chmod(root, 0o700);
  const scriptPath = path.join(root, "decision-policy.cjs");
  const countPath = path.join(root, "policy-count.txt");
  await fs.writeFile(
    scriptPath,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  JSON.parse(input);",
      "  let count = 0;",
      "  try { count = Number(fs.readFileSync(process.env.POLICY_COUNT_PATH, 'utf8')) || 0; } catch {}",
      "  fs.writeFileSync(process.env.POLICY_COUNT_PATH, String(count + 1));",
      "  const decision = process.env.POLICY_DECISION;",
      "  if (decision === 'allow') {",
      "    process.stdout.write(JSON.stringify({ protocolVersion: 1, decision }));",
      "    return;",
      "  }",
      "  process.stdout.write(JSON.stringify({",
      "    protocolVersion: 1,",
      "    decision,",
      "    reason: decision === 'warn' ? 'source review required' : 'source blocked on re-evaluation',",
      "    findings: [{",
      "      ruleId: 'proof.source',",
      "      severity: decision === 'warn' ? 'warn' : 'critical',",
      "      message: 'Review the staged skill source.',",
      "    }],",
      "  }));",
      "});",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { scriptPath, countPath };
}

function decisionPolicyConfig(params: {
  scriptPath: string;
  countPath: string;
  decision: "allow" | "warn" | "block";
}): OpenClawConfig {
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: {
          source: "exec",
          command: params.scriptPath,
          env: {
            POLICY_COUNT_PATH: params.countPath,
            POLICY_DECISION: params.decision,
          },
          trustedDirs: [path.dirname(params.scriptPath)],
        },
      },
    },
  };
}

describe("installSkillFromSource", () => {
  it("installs a local skill directory using the SKILL.md frontmatter name", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-local-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const sourceDir = path.join(root, "source");
      const scriptPath = await writeCapturePolicyScript(root);
      const capturePath = path.join(root, "policy-stdin.json");
      await writeSkill(sourceDir, { name: "frontmatter-skill" });

      const result = await installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
        config: capturePolicyConfig({ scriptPath, capturePath }),
      });

      expect(result).toMatchObject({
        ok: true,
        slug: "frontmatter-skill",
        source: "path",
        targetDir: path.join(workspaceDir, "skills", "frontmatter-skill"),
      });
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "frontmatter-skill", "SKILL.md"), "utf8"),
      ).resolves.toContain("frontmatter-skill");
      const payload = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        sourcePath?: string;
      };
      expect(payload.sourcePath).not.toBe(await fs.realpath(sourceDir));
      expect(path.basename(payload.sourcePath ?? "")).toMatch(/^\.openclaw-install-stage-/);
    });
  });

  it("uses --as slug override for local skill directories", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-as-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const sourceDir = path.join(root, "source");
      await writeSkill(sourceDir, { name: "frontmatter-skill" });

      const result = await installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
        slug: "custom-name",
      });

      expect(result).toMatchObject({
        ok: true,
        slug: "custom-name",
        source: "path",
        targetDir: path.join(workspaceDir, "skills", "custom-name"),
      });
      const status = buildWorkspaceSkillStatus(workspaceDir, {
        managedSkillsDir: path.join(root, "managed-skills"),
      });
      const skill = status.skills.find((entry) => entry.skillKey === "custom-name");
      expect(skill).toMatchObject({
        name: "frontmatter-skill",
        skillKey: "custom-name",
      });
    });
  });

  it("keeps source installs uncommitted on warning and re-evaluates acknowledged updates", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-warning-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const sourceDir = path.join(root, "source");
      const targetDir = path.join(workspaceDir, "skills", "reviewed-source");
      const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
      await writeSkill(sourceDir, { name: "reviewed-source", description: "Original source" });
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const originalLock = `${JSON.stringify({
        version: 1,
        skills: {
          "reviewed-source": { version: "0.9.0", installedAt: 1 },
        },
      })}\n`;
      await fs.writeFile(lockPath, originalLock);
      const policy = await writeDecisionPolicyScript(root);
      const warningConfig = decisionPolicyConfig({ ...policy, decision: "warn" });

      const first = await installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
        config: warningConfig,
      });

      expect(first).toMatchObject({
        ok: false,
        error: "source review required",
        installPolicyWarning: {
          reason: "source review required",
          findings: [
            {
              ruleId: "proof.source",
              severity: "warn",
              message: "Review the staged skill source.",
            },
          ],
        },
      });
      await expect(fs.access(targetDir)).rejects.toThrow();
      await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(originalLock);
      await expect(fs.readFile(policy.countPath, "utf8")).resolves.toBe("1");

      const acknowledged = await installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
        config: warningConfig,
        onInstallPolicyWarning: async () => true,
      });

      expect(acknowledged).toMatchObject({ ok: true, targetDir });
      await expect(fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).resolves.toContain(
        "Original source",
      );
      await expect(fs.readFile(policy.countPath, "utf8")).resolves.toBe("3");

      await writeSkill(sourceDir, { name: "reviewed-source", description: "Changed source" });
      const blocked = await installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
        force: true,
        config: decisionPolicyConfig({ ...policy, decision: "block" }),
        onInstallPolicyWarning: async () => true,
      });

      expect(blocked).toMatchObject({
        ok: false,
        error: "blocked by install policy: source blocked on re-evaluation",
      });
      await expect(fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).resolves.toContain(
        "Original source",
      );
      await expect(fs.readFile(policy.countPath, "utf8")).resolves.toBe("4");
    });
  });

  it("ignores oversized source-origin metadata while loading skill keys", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-origin-cap-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const sourceDir = path.join(root, "source");
      await writeSkill(sourceDir, { name: "frontmatter-skill" });

      const result = await installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
        slug: "custom-name",
      });

      expect(result).toMatchObject({ ok: true });
      await fs.writeFile(
        path.join(workspaceDir, "skills", "custom-name", ".openclaw", "source-origin.json"),
        "x".repeat(20 * 1024),
      );

      const status = buildWorkspaceSkillStatus(workspaceDir, {
        managedSkillsDir: path.join(root, "managed-skills"),
      });
      expect(status.skills.find((entry) => entry.skillKey === "custom-name")).toBeUndefined();
      expect(status.skills.find((entry) => entry.skillKey === "frontmatter-skill")).toBeDefined();
    });
  });

  it("installs git: file repositories and records the resolved commit", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-git-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const repoDir = path.join(root, "repo");
      await fs.mkdir(repoDir, { recursive: true });
      await initGitSkillRepo(repoDir);

      const result = await installSkillFromSource({
        workspaceDir,
        spec: `git:file://${repoDir}`,
      });

      expect(result).toMatchObject({
        ok: true,
        slug: "git-skill",
        source: "git",
        targetDir: path.join(workspaceDir, "skills", "git-skill"),
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(result.git?.commit).toMatch(/^[0-9a-f]{40}$/);
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "git-skill", "SKILL.md"), "utf8"),
      ).resolves.toContain("git-skill");
      await expect(
        fs.access(path.join(workspaceDir, "skills", "git-skill", ".git")),
      ).rejects.toThrow();
    });
  });

  it("isolates git commands from inherited Git hook environment", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-git-env-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const repoDir = path.join(root, "repo");
      const poisonRepoDir = path.join(root, "poison");
      await fs.mkdir(repoDir, { recursive: true });
      await fs.mkdir(poisonRepoDir, { recursive: true });
      await initGitSkillRepo(repoDir);
      await initGitSkillRepo(poisonRepoDir);
      await fs.writeFile(path.join(poisonRepoDir, "extra.txt"), "poison\n");
      await runGitOk(poisonRepoDir, ["add", "extra.txt"]);
      await runGitOk(poisonRepoDir, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-m",
        "poison commit",
      ]);
      const expectedCommit = await runGitOk(repoDir, ["rev-parse", "HEAD"]);
      const oldGitDir = process.env.GIT_DIR;
      try {
        process.env.GIT_DIR = path.join(poisonRepoDir, ".git");
        const result = await installSkillFromSource({
          workspaceDir,
          spec: `git:file://${repoDir}`,
        });

        expect(result).toMatchObject({
          ok: true,
          source: "git",
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        expect(result.git?.commit).toBe(expectedCommit);
      } finally {
        if (oldGitDir === undefined) {
          delete process.env.GIT_DIR;
        } else {
          process.env.GIT_DIR = oldGitDir;
        }
      }
    });
  });

  it("disables system git config while preserving sanitized git command env", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-git-system-config-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const repoDir = path.join(root, "repo");
      const poisonRepoDir = path.join(root, "poison");
      await fs.mkdir(repoDir, { recursive: true });
      await fs.mkdir(poisonRepoDir, { recursive: true });
      await initGitSkillRepo(repoDir, "good-skill");
      await initGitSkillRepo(poisonRepoDir, "poison-skill");
      const systemConfig = path.join(root, "system.gitconfig");
      await fs.writeFile(
        systemConfig,
        `[url "file://${poisonRepoDir}/"]\n\tinsteadOf = file://${repoDir}\n`,
      );
      const oldSystemConfig = process.env.GIT_CONFIG_SYSTEM;
      try {
        process.env.GIT_CONFIG_SYSTEM = systemConfig;
        const result = await installSkillFromSource({
          workspaceDir,
          spec: `git:file://${repoDir}`,
        });

        expect(result).toMatchObject({
          ok: true,
          slug: "good-skill",
          source: "git",
        });
      } finally {
        if (oldSystemConfig === undefined) {
          delete process.env.GIT_CONFIG_SYSTEM;
        } else {
          process.env.GIT_CONFIG_SYSTEM = oldSystemConfig;
        }
      }
    });
  });

  it("installs slash-containing git branch refs from fresh clones", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-git-ref-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const repoDir = path.join(root, "repo");
      await fs.mkdir(repoDir, { recursive: true });
      await initGitSkillRepo(repoDir);
      await runGitOk(repoDir, ["branch", "-M", "main"]);
      await runGitOk(repoDir, ["checkout", "-b", "feature/skill"]);
      await writeSkill(repoDir, { name: "feature-skill", description: "Feature branch skill" });
      await runGitOk(repoDir, ["add", "SKILL.md"]);
      await runGitOk(repoDir, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-m",
        "update skill on branch",
      ]);
      await runGitOk(repoDir, ["checkout", "main"]);

      const result = await installSkillFromSource({
        workspaceDir,
        spec: `git:file://${repoDir}@feature/skill`,
      });

      expect(result).toMatchObject({
        ok: true,
        slug: "feature-skill",
        source: "git",
        targetDir: path.join(workspaceDir, "skills", "feature-skill"),
      });
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "feature-skill", "SKILL.md"), "utf8"),
      ).resolves.toContain("Feature branch skill");
    });
  });

  it.each([
    {
      name: "default branch",
      ref: undefined,
      expectedMutable: true,
    },
    {
      name: "full commit",
      ref: "commit",
      expectedMutable: false,
    },
  ] as const)(
    "reports $name git skill sources with expected mutability to policy",
    async (entry) => {
      await withTempDir({ prefix: "openclaw-skill-source-git-policy-" }, async (root) => {
        const workspaceDir = path.join(root, "workspace");
        const repoDir = path.join(root, "repo");
        await fs.mkdir(repoDir, { recursive: true });
        await initGitSkillRepo(repoDir);
        const commit = await runGitOk(repoDir, ["rev-parse", "HEAD"]);
        const scriptPath = await writeCapturePolicyScript(root);
        const capturePath = path.join(root, "policy-stdin.json");
        const ref = entry.ref === "commit" ? commit : entry.ref;

        const result = await installSkillFromSource({
          workspaceDir,
          spec: `git:file://${repoDir}${ref ? `@${ref}` : ""}`,
          config: capturePolicyConfig({ scriptPath, capturePath }),
        });

        if (!result.ok) {
          throw new Error(result.error);
        }
        expect(result.ok).toBe(true);
        const payload = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
          source?: { kind?: string; mutable?: boolean };
        };
        expect(payload.source).toMatchObject({
          kind: "git",
          mutable: entry.expectedMutable,
        });
      });
    },
  );

  it("removes stale ClawHub lock tracking after source installs", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-untrack-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const sourceDir = path.join(root, "source");
      await writeSkill(sourceDir, { name: "frontmatter-skill" });
      await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
      await fs.mkdir(path.join(sourceDir, ".clawhub"), { recursive: true });
      await fs.writeFile(
        path.join(sourceDir, ".clawhub", "origin.json"),
        JSON.stringify({
          version: 1,
          registry: "https://clawhub.example",
          slug: "frontmatter-skill",
          installedVersion: "1.0.0",
          installedAt: 1,
        }),
      );
      await fs.writeFile(
        path.join(workspaceDir, ".clawhub", "lock.json"),
        JSON.stringify(
          {
            version: 1,
            skills: {
              "frontmatter-skill": {
                version: "1.0.0",
                installedAt: 1,
              },
            },
          },
          null,
          2,
        ),
      );

      const result = await installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
      });

      expect(result).toMatchObject({
        ok: true,
        slug: "frontmatter-skill",
      });
      const lock = JSON.parse(
        await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
      ) as { skills: Record<string, unknown> };
      expect(lock.skills["frontmatter-skill"]).toBeUndefined();
      await expect(
        fs.access(path.join(workspaceDir, "skills", "frontmatter-skill", ".clawhub")),
      ).rejects.toThrow();
    });
  });

  it("rejects missing local skill roots before treating them as ClawHub slugs", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-missing-" }, async (root) => {
      const result = await installSkillFromSource({
        workspaceDir: path.join(root, "workspace"),
        spec: "./missing-skill",
      });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Skill path not found"),
      });
    });
  });

  it("refuses git specs whose url would be consumed as a git clone option", async () => {
    await withTempDir({ prefix: "openclaw-skill-source-opt-inject-" }, async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const payload = path.join(root, "payload.git");

      const result = await installSkillFromSource({
        workspaceDir,
        spec: `git:--upload-pack=${payload}`,
      });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Unsupported git skill spec"),
      });
    });
  });
});
