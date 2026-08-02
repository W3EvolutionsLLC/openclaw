import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  createInstallPolicyWarningAcknowledger,
  type InstallPolicyWarning,
} from "../plugins/install-security-scan.js";

function installPolicyWarningPlanIdentity(warning: InstallPolicyWarning): object {
  if (warning.acknowledgementId) {
    // The acknowledgement id already binds the request, artifact digest, and
    // canonicalized warning content without transient extraction paths.
    return { acknowledgementId: warning.acknowledgementId };
  }
  return {
    reason: warning.reason,
    ...(warning.findings
      ? {
          findings: warning.findings.toSorted((left, right) => {
            const leftKey = stableStringify(left);
            const rightKey = stableStringify(right);
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          }),
        }
      : {}),
  };
}

export function canonicalizeInstallPolicyWarningsForPlan(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeInstallPolicyWarningsForPlan);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key === "installPolicyWarning" &&
      nested &&
      typeof nested === "object" &&
      "reason" in nested &&
      typeof nested.reason === "string"
        ? installPolicyWarningPlanIdentity(nested as InstallPolicyWarning)
        : canonicalizeInstallPolicyWarningsForPlan(nested),
    ]),
  );
}

export function digestClawPlanValue(value: unknown): string {
  return `sha256:${sha256Hex(stableStringify(canonicalizeInstallPolicyWarningsForPlan(value)))}`;
}

export async function createClawInstallPolicyWarningHandler(params: {
  plannedWarnings: InstallPolicyWarning[];
  onWarning?: (warning: InstallPolicyWarning) => boolean | Promise<boolean>;
  acknowledgeUnplannedWarnings?: boolean;
  rejectionError: (warning: InstallPolicyWarning) => Error;
}): Promise<(warning: InstallPolicyWarning) => Promise<boolean>> {
  const acknowledged: Array<(warning: InstallPolicyWarning) => boolean | Promise<boolean>> = [];
  for (const warning of params.plannedWarnings) {
    if (!(await params.onWarning?.(warning))) {
      throw params.rejectionError(warning);
    }
    acknowledged.push(
      createInstallPolicyWarningAcknowledger(warning.acknowledgementId) ??
        ((observed) => stableStringify(observed) === stableStringify(warning)),
    );
  }
  return async (warning) => {
    for (const isAcknowledged of acknowledged) {
      if (await isAcknowledged(warning)) {
        return true;
      }
    }
    if (!params.acknowledgeUnplannedWarnings) {
      return false;
    }
    return (await params.onWarning?.(warning)) ?? false;
  };
}
