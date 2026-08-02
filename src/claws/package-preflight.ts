import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preflightClawPackage } from "./packages.js";

type ClawPackagePreflight = typeof preflightClawPackage;

/** Binds one config snapshot to every package preflight for a Claw plan/apply cycle. */
export function createConfiguredClawPackagePreflight(
  config: OpenClawConfig,
  preflight: ClawPackagePreflight = preflightClawPackage,
): ClawPackagePreflight {
  return async (pkg, workspace) => await preflight(pkg, workspace, { config });
}
