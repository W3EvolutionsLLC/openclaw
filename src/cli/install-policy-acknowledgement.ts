import { formatInstallPolicyWarningDetails } from "../../packages/gateway-protocol/src/install-policy-warning-details.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { InstallPolicyWarning } from "../plugins/install-security-scan.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install-types.js";
import { promptYesNo } from "./prompt.js";

function canPromptForInstallPolicyWarning(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export function buildInstallPolicyAcknowledgementRequiredError(
  message: string,
  guidance: string,
): { code: string; message: string } {
  return {
    code: PLUGIN_INSTALL_ERROR_CODE.INSTALL_POLICY_ACKNOWLEDGEMENT_REQUIRED,
    message: message.includes(guidance) ? message : `${message} ${guidance}`,
  };
}

export function resolveInstallPolicyAcknowledgementCliOptions(params: {
  dangerouslyForceUnsafeInstall?: boolean;
  action: "install" | "update";
  allowPrompt?: boolean;
  reportError?: (message: string) => void;
}): {
  onInstallPolicyWarning?: (warning: InstallPolicyWarning) => Promise<boolean>;
} {
  if (params.dangerouslyForceUnsafeInstall === true) {
    return { onInstallPolicyWarning: async () => true };
  }
  if (params.allowPrompt === false || !canPromptForInstallPolicyWarning()) {
    return {
      onInstallPolicyWarning: async (warning) => {
        params.reportError?.(
          `${formatInstallPolicyWarningDetails(warning, sanitizeTerminalText)}\nInstall policy warning requires acknowledgement. Review the warning, then rerun with --dangerously-force-unsafe-install to ${params.action}.`,
        );
        return false;
      },
    };
  }
  return {
    onInstallPolicyWarning: async (warning) =>
      await promptYesNo(
        `${params.action === "install" ? "Install" : "Update"} after this policy warning?\n${formatInstallPolicyWarningDetails(
          warning,
          sanitizeTerminalText,
        )}`,
      ),
  };
}
