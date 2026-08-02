import { formatInstallPolicyWarningDetails } from "../../packages/gateway-protocol/src/install-policy-warning-details.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { InstallPolicyWarning } from "../plugins/install-security-scan.js";
import type { WizardPrompter } from "./prompts.js";

export async function confirmWizardInstallPolicyWarning(params: {
  prompter: WizardPrompter;
  warning: InstallPolicyWarning;
}): Promise<boolean> {
  await params.prompter.note(
    formatInstallPolicyWarningDetails(params.warning, sanitizeTerminalText),
    "Install policy warning",
  );
  return await params.prompter.confirm({
    message: "Continue after reviewing this install policy warning?",
    initialValue: false,
  });
}
