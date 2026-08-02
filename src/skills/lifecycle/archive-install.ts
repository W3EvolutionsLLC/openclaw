// Archive install helpers extract and validate skill archives during installation.
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ArchiveLogger } from "../../infra/archive.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pathExists } from "../../infra/fs-safe.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { installPackageDir } from "../../infra/install-package-dir.js";
import { resolveSafeInstallDir } from "../../infra/install-safe-path.js";
import {
  evaluateSkillInstallPolicy,
  formatInstallPolicyWarningReasonForTerminal,
  type InstallPolicyWarning,
  type InstallSecurityScanResult,
} from "../../plugins/install-security-scan.js";
import type { InstallPolicyOrigin, InstallPolicySource } from "../../security/install-policy.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  resolveCommittedSkillChangeSource,
  snapshotCommittedSkillArtifactBestEffort,
} from "./skill-change-hook.js";

const VALID_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS = ["SKILL.md"] as const;
/** Accepted root marker names for ClawHub skill archive uploads. */
export const CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS = [
  "SKILL.md",
  "skill.md",
  "skills.md",
  "SKILL.MD",
] as const;

function hasNonAscii(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) > 0x7f) {
      return true;
    }
  }
  return false;
}

type SkillArchiveInstallPolicy = {
  config?: OpenClawConfig;
  installId?: string;
  origin: InstallPolicyOrigin;
  requestedSpecifier?: string;
  onInstallPolicyWarning?: (warning: InstallPolicyWarning) => boolean | Promise<boolean>;
  source?: InstallPolicySource;
};

async function evaluateSkillInstallSourcePolicy(params: {
  sourceDir: string;
  logicalSourcePath?: string;
  slug: string;
  mode: "install" | "update";
  logger?: ArchiveLogger;
  policy?: SkillArchiveInstallPolicy;
}): Promise<InstallSecurityScanResult | undefined> {
  if (!params.policy) {
    return undefined;
  }
  const source = params.policy.source;
  const logicalSourcePath =
    params.logicalSourcePath ??
    (source && !source.network && (source.kind === "local-path" || source.kind === "workspace")
      ? params.sourceDir
      : undefined);
  return await evaluateSkillInstallPolicy({
    config: params.policy.config,
    installId: params.policy.installId ?? "archive",
    logger: params.logger ?? {},
    ...(logicalSourcePath ? { logicalSourcePath } : {}),
    origin: params.policy.origin,
    onInstallPolicyWarning: params.policy.onInstallPolicyWarning,
    requestedSpecifier: params.policy.requestedSpecifier,
    source,
    mode: params.mode,
    skillName: params.slug,
    sourceDir: params.sourceDir,
  });
}

/** Result shape for installing a skill archive into a workspace skills dir. */
export type SkillArchiveInstallResult =
  | { ok: true; targetDir: string }
  | {
      ok: false;
      error: string;
      failureKind: SkillArchiveInstallFailureKind;
      installPolicyFailure?: true;
      installPolicyWarning?: InstallPolicyWarning;
    };

export type SkillArchiveInstallFailureKind =
  | "acknowledgement-required"
  | "invalid-request"
  | "unavailable";

/** Normalizes a tracked slug without accepting traversal or path separators. */
export function normalizeTrackedSkillSlug(raw: string): string {
  const slug = raw.trim();
  if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

export function validateRequestedSkillSlug(raw: string): string {
  const slug = normalizeTrackedSkillSlug(raw);
  if (hasNonAscii(slug) || !VALID_SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

export function resolveWorkspaceSkillInstallDir(workspaceDir: string, slug: string): string {
  const skillsDir = path.join(path.resolve(workspaceDir), "skills");
  const target = resolveSafeInstallDir({
    baseDir: skillsDir,
    id: slug,
    invalidNameMessage: "invalid skill target path",
  });
  if (!target.ok) {
    throw new Error(target.error);
  }
  return target.path;
}

function installFailure(
  error: string,
  failureKind: SkillArchiveInstallFailureKind,
  installPolicyWarning?: InstallPolicyWarning,
  installPolicyFailure?: true,
): Extract<SkillArchiveInstallResult, { ok: false }> {
  return {
    ok: false,
    error,
    failureKind,
    ...(installPolicyFailure ? { installPolicyFailure } : {}),
    ...(installPolicyWarning ? { installPolicyWarning } : {}),
  };
}

async function hasSkillArchiveRoot(
  rootDir: string,
  rootMarkers: readonly string[],
): Promise<boolean> {
  for (const candidate of rootMarkers) {
    if (await pathExists(path.join(rootDir, candidate))) {
      return true;
    }
  }
  return false;
}

function scanBlockedFailureKind(
  blocked: NonNullable<InstallSecurityScanResult["blocked"]>,
): SkillArchiveInstallFailureKind {
  return blocked.code === "security_scan_failed" ? "unavailable" : "invalid-request";
}

const TRANSIENT_ARCHIVE_ERROR_PATTERNS = [
  "enoent",
  "enospc",
  "eio",
  "eacces",
  "eperm",
  "ebusy",
  "emfile",
  "enfile",
  "timeout",
  "timed out",
] as const;

function archiveFailureKind(error: string): SkillArchiveInstallFailureKind {
  const lower = error.toLowerCase();
  if (lower.startsWith("failed to install skill:")) {
    return "unavailable";
  }
  for (const pattern of TRANSIENT_ARCHIVE_ERROR_PATTERNS) {
    if (lower.includes(pattern)) {
      return "unavailable";
    }
  }
  return "invalid-request";
}

export async function installExtractedSkillRoot(params: {
  workspaceDir: string;
  slug: string;
  extractedRoot: string;
  mode: "install" | "update";
  scanOnly?: boolean;
  timeoutMs?: number;
  logger?: ArchiveLogger;
  policy?: SkillArchiveInstallPolicy;
  rootMarkers?: readonly string[];
}): Promise<SkillArchiveInstallResult> {
  try {
    if (
      !(await hasSkillArchiveRoot(
        params.extractedRoot,
        params.rootMarkers ?? DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS,
      ))
    ) {
      return installFailure("archive is missing SKILL.md", "invalid-request");
    }
    let targetDir: string;
    try {
      targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
    } catch (err) {
      return installFailure(formatErrorMessage(err), "invalid-request");
    }
    const targetExists = await pathExists(targetDir);
    const effectiveMode = params.mode === "update" && targetExists ? "update" : "install";
    if (params.mode === "install" && targetExists) {
      return installFailure(
        `Skill already exists at ${targetDir}. Re-run with force/update.`,
        "invalid-request",
      );
    }
    const changeSource = resolveCommittedSkillChangeSource(params.policy?.origin.type);
    const sourceVersionValue =
      params.policy?.origin.version ?? params.policy?.origin.commit ?? undefined;
    const sourceVersion =
      typeof sourceVersionValue === "string" || typeof sourceVersionValue === "number"
        ? String(sourceVersionValue)
        : undefined;
    const shouldDispatchChange = !params.scanOnly && hasCommittedSkillChangeHooks();
    const before =
      shouldDispatchChange && effectiveMode === "update"
        ? await snapshotCommittedSkillArtifactBestEffort({
            skillDir: targetDir,
            skillKey: params.slug,
            source: changeSource,
            logger: params.logger,
          })
        : undefined;

    const evaluateStagedPolicy = async (
      sourceDir: string,
    ): Promise<Extract<SkillArchiveInstallResult, { ok: false }> | null> => {
      const policySource = params.policy?.source;
      const logicalSourcePath =
        policySource &&
        !policySource.network &&
        (policySource.kind === "local-path" || policySource.kind === "workspace")
          ? params.extractedRoot
          : undefined;
      const scanResult = await evaluateSkillInstallSourcePolicy({
        sourceDir,
        ...(logicalSourcePath ? { logicalSourcePath } : {}),
        slug: params.slug,
        mode: effectiveMode,
        logger: params.logger,
        policy: params.policy,
      });
      if (scanResult?.blocked) {
        return installFailure(
          scanResult.blocked.reason,
          scanBlockedFailureKind(scanResult.blocked),
          undefined,
          true,
        );
      }
      if (scanResult?.warning) {
        return installFailure(
          formatInstallPolicyWarningReasonForTerminal(scanResult.warning),
          "acknowledgement-required",
          scanResult.warning,
          true,
        );
      }
      return null;
    };

    const install = await installPackageDir<Extract<SkillArchiveInstallResult, { ok: false }>>({
      sourceDir: params.extractedRoot,
      targetDir,
      mode: effectiveMode,
      timeoutMs: params.timeoutMs ?? 120_000,
      logger: params.logger,
      copyErrorPrefix: "failed to install skill",
      hasDeps: false,
      depsLogMessage: "",
      scanOnly: params.scanOnly,
      afterInstall: async (stagedDir) => {
        if (
          !(await hasSkillArchiveRoot(
            stagedDir,
            params.rootMarkers ?? DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS,
          ))
        ) {
          return installFailure("archive is missing SKILL.md", "invalid-request");
        }
        return (await evaluateStagedPolicy(stagedDir)) ?? { ok: true };
      },
    });
    if (!install.ok) {
      if ("failureKind" in install) {
        return install;
      }
      return installFailure(install.error, "unavailable");
    }
    if (shouldDispatchChange) {
      const after = await snapshotCommittedSkillArtifactBestEffort({
        skillDir: targetDir,
        skillKey: params.slug,
        source: changeSource,
        sourceVersion,
        logger: params.logger,
      });
      await dispatchCommittedSkillChangeBestEffort({
        action: effectiveMode === "update" ? "updated" : "created",
        source: changeSource,
        workspaceDir: params.workspaceDir,
        before,
        after,
        logger: params.logger,
      });
    }
    return { ok: true, targetDir };
  } catch (err) {
    return installFailure(formatErrorMessage(err), "unavailable");
  }
}

export async function installSkillArchiveFromPath(params: {
  archivePath: string;
  workspaceDir: string;
  slug: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: ArchiveLogger;
  policy?: SkillArchiveInstallPolicy;
}): Promise<SkillArchiveInstallResult> {
  const result = await withExtractedArchiveRoot({
    archivePath: params.archivePath,
    tempDirPrefix: "openclaw-skill-archive-",
    timeoutMs: params.timeoutMs ?? 120_000,
    logger: params.logger,
    rootMarkers: ["SKILL.md"],
    onExtracted: async (rootDir) =>
      await installExtractedSkillRoot({
        workspaceDir: params.workspaceDir,
        slug: params.slug,
        extractedRoot: rootDir,
        mode: params.force ? "update" : "install",
        timeoutMs: params.timeoutMs,
        logger: params.logger,
        policy: params.policy,
      }),
  });
  if (!result.ok) {
    const error = result.error.includes("unexpected archive layout")
      ? "archive is missing SKILL.md"
      : result.error;
    const failureKind =
      "failureKind" in result &&
      (result.failureKind === "acknowledgement-required" ||
        result.failureKind === "invalid-request" ||
        result.failureKind === "unavailable")
        ? result.failureKind
        : archiveFailureKind(error);
    return installFailure(
      error,
      failureKind,
      "installPolicyWarning" in result ? result.installPolicyWarning : undefined,
      "installPolicyFailure" in result && result.installPolicyFailure ? true : undefined,
    );
  }
  return result;
}
