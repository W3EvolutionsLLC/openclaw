import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec, validateRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmGenerationProjectDirPrefix,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { loadPluginInstallRuntime } from "./install-shared.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import type { OpenClawPackageManifest } from "./manifest.js";

export function resolveManagedNpmRootPackageDir(npmRoot: string, packageName: string): string {
  return path.join(npmRoot, "node_modules", ...packageName.split("/"));
}

function resolveManagedNpmRootGenerationKey(params: {
  packageName: string;
  npmResolution: NpmSpecResolution;
}): string {
  return [
    params.npmResolution.name ?? params.packageName,
    params.npmResolution.version ?? "",
    params.npmResolution.resolvedSpec ?? "",
    params.npmResolution.integrity ?? "",
    params.npmResolution.shasum ?? "",
  ].join("\n");
}

export function resolveManagedNpmRootForInstall(params: {
  npmBaseDir: string;
  packageName: string;
  npmResolution: NpmSpecResolution;
  useGeneration: boolean;
}): string {
  if (!params.useGeneration) {
    return resolvePluginNpmProjectDir({
      npmDir: params.npmBaseDir,
      packageName: params.packageName,
    });
  }
  return resolvePluginNpmGenerationProjectDir({
    npmDir: params.npmBaseDir,
    packageName: params.packageName,
    generationKey: resolveManagedNpmRootGenerationKey({
      packageName: params.packageName,
      npmResolution: params.npmResolution,
    }),
  });
}

export function resolveManagedNpmInstallRoot(params: {
  npmBaseDir: string;
  packageName: string;
  npmResolution: NpmSpecResolution;
  useGeneration: boolean;
}): string {
  const generationKey = resolveManagedNpmRootGenerationKey({
    packageName: params.packageName,
    npmResolution: params.npmResolution,
  });
  const npmRoot = resolveManagedNpmRootForInstall(params);
  const installRoot = resolveManagedNpmRootPackageDir(npmRoot, params.packageName);
  if (!hasRetainedManagedNpmInstallMarker(installRoot)) {
    return npmRoot;
  }
  return resolvePluginNpmGenerationProjectDir({
    npmDir: params.npmBaseDir,
    packageName: params.packageName,
    generationKey: `${generationKey}\nactivation\n${randomUUID()}`,
  });
}

async function listManagedNpmPackageDirsForPackage(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  npmBaseDir: string;
  packageName: string;
}): Promise<string[]> {
  const packageDirs: string[] = [];
  const legacyProjectRoot = resolvePluginNpmProjectDir({
    npmDir: params.npmBaseDir,
    packageName: params.packageName,
  });
  const legacyPackageDir = resolveManagedNpmRootPackageDir(legacyProjectRoot, params.packageName);
  if (await params.runtime.fileExists(legacyPackageDir)) {
    packageDirs.push(legacyPackageDir);
  }
  const projectsDir = path.dirname(legacyProjectRoot);
  const generationPrefix = resolvePluginNpmGenerationProjectDirPrefix(params.packageName);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return packageDirs;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(generationPrefix)) {
      continue;
    }
    const packageDir = resolveManagedNpmRootPackageDir(
      path.join(projectsDir, entry.name),
      params.packageName,
    );
    if (await params.runtime.fileExists(packageDir)) {
      packageDirs.push(packageDir);
    }
  }
  return packageDirs;
}

export async function resolveManagedNpmGenerationUseForInstall(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  npmBaseDir: string;
  packageName: string;
  requestedMode: "install" | "update";
  npmResolution?: NpmSpecResolution;
}): Promise<"none" | "update" | "retained-install"> {
  const packageDirs = await listManagedNpmPackageDirsForPackage({
    runtime: params.runtime,
    npmBaseDir: params.npmBaseDir,
    packageName: params.packageName,
  });
  const hasNonRetainedPackageDir = packageDirs.some(
    (packageDir) => !hasRetainedManagedNpmInstallMarker(packageDir),
  );
  if (packageDirs.length > 0 && !hasNonRetainedPackageDir) {
    return "retained-install";
  }
  const generationUse =
    params.requestedMode === "update" && hasNonRetainedPackageDir ? "update" : "none";
  if (params.npmResolution) {
    const candidateRoot = resolveManagedNpmRootForInstall({
      npmBaseDir: params.npmBaseDir,
      packageName: params.packageName,
      npmResolution: params.npmResolution,
      useGeneration: generationUse !== "none",
    });
    const candidatePackageDir = resolveManagedNpmRootPackageDir(candidateRoot, params.packageName);
    if (hasRetainedManagedNpmInstallMarker(candidatePackageDir)) {
      return "retained-install";
    }
  }
  if (params.requestedMode === "update") {
    return hasNonRetainedPackageDir ? "update" : "none";
  }
  return "none";
}

export function resolveRequiredPlatformPackageNames(
  packageMetadata?: OpenClawPackageManifest,
): { ok: true; packageNames: string[] } | { ok: false; error: string } {
  const raw = packageMetadata?.install?.requiredPlatformPackages as unknown;
  if (raw === undefined) {
    return { ok: true, packageNames: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "package.json openclaw.install.requiredPlatformPackages must be an array",
    };
  }
  const packageNames = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") {
      return {
        ok: false,
        error:
          "package.json openclaw.install.requiredPlatformPackages must contain only npm package names",
      };
    }
    const specError = validateRegistryNpmSpec(value);
    const parsed = parseRegistryNpmSpec(value);
    if (specError || !parsed || parsed.selectorKind !== "none") {
      return {
        ok: false,
        error: `package.json openclaw.install.requiredPlatformPackages contains invalid package name: ${value}`,
      };
    }
    packageNames.add(parsed.name);
  }
  return { ok: true, packageNames: [...packageNames] };
}
