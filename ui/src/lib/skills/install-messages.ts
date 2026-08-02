import {
  ClawHubTrustErrorCodes,
  readClawHubTrustErrorDetails,
} from "../../../../packages/gateway-protocol/src/clawhub-trust-error-details.js";
import { formatInstallPolicyWarning, readInstallPolicyWarning } from "../install-policy-warning.ts";

export type SkillMessage = {
  kind: "success" | "error";
  message: string;
  acknowledgeInstallPolicyWarning?: {
    name: string;
    installId: string;
    acknowledgementId: string;
  };
};

export type ClawHubInstallMessage = {
  kind: "success" | "error";
  text: string;
  acknowledgeSlug?: string;
  acknowledgeVersion?: string;
  acknowledgeLabel?: string;
  acknowledgeClawHubRisk?: true;
  acknowledgeInstallPolicyWarning?: string;
};

export function formatClawHubInstallMessage(message: string, warning?: string): string {
  return warning ? `${message}\n\n${warning}` : message;
}

function formatClawHubAcknowledgementMessage(warning?: string): string {
  return formatClawHubInstallMessage(
    "Review the ClawHub warning before installing this skill.",
    warning,
  );
}

export function buildSkillInstallPolicyWarningMessage(
  error: unknown,
  params: { name: string; installId: string },
): SkillMessage | undefined {
  const warning = readInstallPolicyWarning(error);
  if (!warning) {
    return undefined;
  }
  return {
    kind: "error",
    message: formatInstallPolicyWarning(warning),
    ...(warning.acknowledgementId
      ? {
          acknowledgeInstallPolicyWarning: {
            ...params,
            acknowledgementId: warning.acknowledgementId,
          },
        }
      : {}),
  };
}

function buildClawHubInstallPolicyWarningMessage(
  error: unknown,
  params: { slug: string; version?: string; acknowledgeClawHubRisk: boolean },
): ClawHubInstallMessage | undefined {
  const warning = readInstallPolicyWarning(error);
  if (!warning) {
    return undefined;
  }
  return {
    kind: "error",
    text: formatInstallPolicyWarning(warning),
    ...(warning.acknowledgementId
      ? {
          acknowledgeSlug: params.slug,
          ...(params.version ? { acknowledgeVersion: params.version } : {}),
          ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
          acknowledgeInstallPolicyWarning: warning.acknowledgementId,
        }
      : {}),
  };
}

export function buildClawHubInstallFailureMessage(
  error: unknown,
  params: {
    slug: string;
    version?: string;
    acknowledgeClawHubRisk: boolean;
    fallbackMessage: string;
  },
): { message: ClawHubInstallMessage; installPolicyWarning: boolean } {
  const policyWarning = buildClawHubInstallPolicyWarningMessage(error, params);
  if (policyWarning) {
    return { message: policyWarning, installPolicyWarning: true };
  }
  const details =
    error && typeof error === "object" && "details" in error
      ? readClawHubTrustErrorDetails((error as { details?: unknown }).details)
      : undefined;
  const needsAcknowledgement =
    details?.clawhubTrustCode === ClawHubTrustErrorCodes.RISK_ACKNOWLEDGEMENT_REQUIRED;
  return {
    installPolicyWarning: false,
    message: {
      kind: "error",
      text: needsAcknowledgement
        ? formatClawHubAcknowledgementMessage(details.warning)
        : formatClawHubInstallMessage(params.fallbackMessage, details?.warning),
      ...(needsAcknowledgement ? { acknowledgeSlug: params.slug } : {}),
      ...(needsAcknowledgement && details.version ? { acknowledgeVersion: details.version } : {}),
      ...(needsAcknowledgement ? { acknowledgeLabel: "Acknowledge risk and install" } : {}),
      ...(needsAcknowledgement ? { acknowledgeClawHubRisk: true } : {}),
    },
  };
}
