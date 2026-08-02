import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInstallPolicyAcknowledgementCliOptions } from "./install-policy-acknowledgement.js";

const promptYesNoMock = vi.hoisted(() => vi.fn());

vi.mock("./prompt.js", () => ({
  promptYesNo: promptYesNoMock,
}));

const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restoreTty(): void {
  if (originalStdinTty) {
    Object.defineProperty(process.stdin, "isTTY", originalStdinTty);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  if (originalStdoutTty) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutTty);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

describe("resolveInstallPolicyAcknowledgementCliOptions", () => {
  afterEach(() => {
    promptYesNoMock.mockReset();
    restoreTty();
  });

  it("uses an explicit acknowledgement without prompting", async () => {
    setTty(true);

    const options = resolveInstallPolicyAcknowledgementCliOptions({
      dangerouslyForceUnsafeInstall: true,
      action: "install",
    });

    await expect(
      options.onInstallPolicyWarning?.({ reason: "Manual review required." }),
    ).resolves.toBe(true);
  });

  it("explains how to acknowledge outside an interactive terminal or during dry runs", async () => {
    const reportError = vi.fn();
    setTty(false);
    const nonInteractive = resolveInstallPolicyAcknowledgementCliOptions({
      action: "update",
      reportError,
    });
    await expect(
      nonInteractive.onInstallPolicyWarning?.({
        reason: "Manual review required.",
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "critical",
            message: "Launches an executable.",
            file: "index.js",
            line: 12,
            evidence: "exec(command)",
          },
        ],
      }),
    ).resolves.toBe(false);
    expect(reportError).toHaveBeenLastCalledWith(
      [
        "Manual review required.",
        "• [CRITICAL · dangerous-exec · index.js:12] Launches an executable.",
        "  ↳ exec(command)",
        "Install policy warning requires acknowledgement. Review the warning, then rerun with --dangerously-force-unsafe-install to update.",
      ].join("\n"),
    );

    setTty(true);
    const dryRun = resolveInstallPolicyAcknowledgementCliOptions({
      action: "install",
      allowPrompt: false,
      reportError,
    });
    await expect(
      dryRun.onInstallPolicyWarning?.({ reason: "Manual review required." }),
    ).resolves.toBe(false);
    expect(reportError).toHaveBeenLastCalledWith(
      [
        "Manual review required.",
        "Install policy warning requires acknowledgement. Review the warning, then rerun with --dangerously-force-unsafe-install to install.",
      ].join("\n"),
    );
    expect(promptYesNoMock).not.toHaveBeenCalled();
  });

  it("sanitizes and confirms an interactive policy warning", async () => {
    setTty(true);
    promptYesNoMock.mockResolvedValueOnce(true);
    const options = resolveInstallPolicyAcknowledgementCliOptions({
      action: "install",
    });

    await expect(
      options.onInstallPolicyWarning?.({
        reason: "Review\nthis\u001b[2K package.",
        findings: [
          {
            ruleId: "dangerous\u001b[2K-exec",
            severity: "critical",
            message: "Launches\nan executable.",
            file: "index\u001b[2K.js",
            line: 12,
            evidence: "exec(\ncommand)",
          },
          {
            ruleId: "network-access",
            severity: "info",
            message: "Connects to the network.",
          },
        ],
      }),
    ).resolves.toBe(true);
    expect(promptYesNoMock).toHaveBeenCalledWith(
      [
        "Install after this policy warning?",
        "Review\\nthis package.",
        "• [CRITICAL · dangerous-exec · index.js:12] Launches\\nan executable.",
        "  ↳ exec(\\ncommand)",
        "• [INFO · network-access] Connects to the network.",
      ].join("\n"),
    );
  });
});
