// Defines plugin install security scan result types.
import type { InstallPolicyWarningDetails } from "../../packages/gateway-protocol/src/install-policy-warning-details.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type InstallPolicyWarning = InstallPolicyWarningDetails["installPolicyWarning"];
type InstallPolicyWarningAcknowledger = (
  warning: InstallPolicyWarning,
) => boolean | Promise<boolean>;

const INSTALL_POLICY_ACKNOWLEDGEMENT_PREFIX = "v1:";
const INSTALL_POLICY_ACKNOWLEDGEMENT_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_INSTALL_POLICY_ACKNOWLEDGEMENTS = 1_000;

function parseInstallPolicyWarningAcknowledgementIds(
  token: string | undefined,
): Set<string> | undefined {
  const normalized = token?.trim();
  if (!normalized?.startsWith(INSTALL_POLICY_ACKNOWLEDGEMENT_PREFIX)) {
    return undefined;
  }
  const digests = normalized.slice(INSTALL_POLICY_ACKNOWLEDGEMENT_PREFIX.length).split(".");
  if (
    digests.length === 0 ||
    digests.length > MAX_INSTALL_POLICY_ACKNOWLEDGEMENTS ||
    digests.some((digest) => !INSTALL_POLICY_ACKNOWLEDGEMENT_DIGEST_PATTERN.test(digest))
  ) {
    return undefined;
  }
  return new Set(digests.map((digest) => `${INSTALL_POLICY_ACKNOWLEDGEMENT_PREFIX}${digest}`));
}

function serializeInstallPolicyWarningAcknowledgementIds(ids: Set<string>): string {
  return `${INSTALL_POLICY_ACKNOWLEDGEMENT_PREFIX}${[...ids]
    .map((id) => id.slice(INSTALL_POLICY_ACKNOWLEDGEMENT_PREFIX.length))
    .join(".")}`;
}

export function formatInstallPolicyWarningReasonForTerminal(warning: InstallPolicyWarning): string {
  return sanitizeTerminalText(warning.reason);
}

/** Result returned by plugin/skill install security policy checks. */
export type InstallSecurityScanResult =
  | {
      blocked: {
        code?: "security_scan_blocked" | "security_scan_failed";
        reason: string;
      };
      warning?: never;
    }
  | {
      blocked?: never;
      warning: InstallPolicyWarning;
    };

/** Overrides that intentionally loosen install safety policy for trusted/operator paths. */
export type InstallSafetyOverrides = {
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallPolicyWarningAcknowledger;
  dangerouslyForceUnsafeInstall?: boolean;
  trustedSourceLinkedOfficialInstall?: boolean;
};

export function buildInstallPolicyAcknowledgementOptions(
  overrides: InstallSafetyOverrides,
): Pick<InstallSafetyOverrides, "onInstallPolicyWarning"> {
  return overrides.onInstallPolicyWarning
    ? { onInstallPolicyWarning: overrides.onInstallPolicyWarning }
    : {};
}

/** Converts a Gateway retry token into acknowledgement of the exact warning that issued it. */
export function createInstallPolicyWarningAcknowledger(
  acknowledgementId: string | undefined,
): InstallPolicyWarningAcknowledger | undefined {
  const acknowledgedIds = parseInstallPolicyWarningAcknowledgementIds(acknowledgementId);
  if (!acknowledgedIds) {
    return undefined;
  }
  return (warning) =>
    warning.acknowledgementId !== undefined && acknowledgedIds.has(warning.acknowledgementId);
}

/** Adds the latest warning to an existing Gateway acknowledgement token. */
export function accumulateInstallPolicyWarningAcknowledgement(
  acknowledgementId: string | undefined,
  warning: InstallPolicyWarning,
): InstallPolicyWarning {
  const warningIds = parseInstallPolicyWarningAcknowledgementIds(warning.acknowledgementId);
  if (!warningIds || warningIds.size !== 1) {
    return warning;
  }
  const acknowledgedIds =
    parseInstallPolicyWarningAcknowledgementIds(acknowledgementId) ?? new Set<string>();
  for (const warningId of warningIds) {
    acknowledgedIds.add(warningId);
  }
  if (acknowledgedIds.size > MAX_INSTALL_POLICY_ACKNOWLEDGEMENTS) {
    return warning;
  }
  return {
    ...warning,
    acknowledgementId: serializeInstallPolicyWarningAcknowledgementIds(acknowledgedIds),
  };
}

/** Combines sequential install stages into one disclosure and acknowledgement token. */
export function accumulateInstallPolicyWarningsForSingleConsent(
  current: InstallPolicyWarning | undefined,
  warning: InstallPolicyWarning,
): InstallPolicyWarning {
  if (!current) {
    return warning;
  }
  const accumulated = accumulateInstallPolicyWarningAcknowledgement(
    current.acknowledgementId,
    warning,
  );
  return {
    reason:
      current.reason === warning.reason ? current.reason : `${current.reason}\n${warning.reason}`,
    ...(current.findings || warning.findings
      ? { findings: [...(current.findings ?? []), ...(warning.findings ?? [])].slice(0, 100) }
      : {}),
    ...(accumulated.acknowledgementId ? { acknowledgementId: accumulated.acknowledgementId } : {}),
  };
}
