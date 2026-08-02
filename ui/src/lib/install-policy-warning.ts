import {
  formatInstallPolicyWarningDetails,
  readInstallPolicyWarningDetails,
  type InstallPolicyWarningDetails,
} from "../../../packages/gateway-protocol/src/install-policy-warning-details.js";

export type InstallPolicyWarning = InstallPolicyWarningDetails["installPolicyWarning"];

export function formatInstallPolicyWarning(warning: InstallPolicyWarning): string {
  return formatInstallPolicyWarningDetails(warning);
}

export function readInstallPolicyWarning(error: unknown): InstallPolicyWarning | undefined {
  if (!error || typeof error !== "object" || !("details" in error)) {
    return undefined;
  }
  return readInstallPolicyWarningDetails((error as { details?: unknown }).details)
    ?.installPolicyWarning;
}
