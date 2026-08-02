import { describe, expect, it } from "vitest";
import {
  buildInstallPolicyWarningDetails,
  formatInstallPolicyWarningDetails,
  readInstallPolicyWarningDetails,
} from "./install-policy-warning-details.js";

describe("install-policy warning details", () => {
  it("round-trips a warning with findings", () => {
    const details = buildInstallPolicyWarningDetails({
      warning: {
        reason: "manual review recommended",
        acknowledgementId: "v1:warning-token",
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "warn",
            message: "The package launches a child process.",
            file: "index.js",
            line: 12,
          },
        ],
      },
    });

    expect(details).toEqual({
      installPolicyWarning: {
        reason: "manual review recommended",
        acknowledgementId: "v1:warning-token",
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "warn",
            message: "The package launches a child process.",
            file: "index.js",
            line: 12,
          },
        ],
      },
    });
  });

  it("formats every finding with location and evidence", () => {
    expect(
      formatInstallPolicyWarningDetails({
        reason: "manual review recommended",
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "critical",
            message: "The package launches a child process.",
            file: "index.js",
            line: 12,
            evidence: "exec(command)",
          },
          {
            ruleId: "network-access",
            severity: "info",
            message: "The package opens a network connection.",
            line: 7,
          },
        ],
      }),
    ).toBe(
      [
        "manual review recommended",
        "• [CRITICAL · dangerous-exec · index.js:12] The package launches a child process.",
        "  ↳ exec(command)",
        "• [INFO · network-access · line 7] The package opens a network connection.",
      ].join("\n"),
    );
  });

  it("reads valid warning details and preserves the acknowledgement token", () => {
    expect(
      readInstallPolicyWarningDetails({
        installPolicyWarning: {
          reason: " manual review recommended ",
          acknowledgementId: "v1:warning-token",
          findings: [
            {
              ruleId: "dangerous-exec",
              severity: "warn",
              message: "The package launches a child process.",
              file: "index.js",
              line: 12,
            },
            { ruleId: "broken", severity: "unknown", message: "ignored" },
          ],
        },
      }),
    ).toEqual({
      installPolicyWarning: {
        reason: "manual review recommended",
        acknowledgementId: "v1:warning-token",
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "warn",
            message: "The package launches a child process.",
            file: "index.js",
            line: 12,
          },
        ],
      },
    });
  });

  it("keeps a warning visible but drops a malformed acknowledgement token", () => {
    expect(
      readInstallPolicyWarningDetails({
        installPolicyWarning: {
          reason: "manual review recommended",
          acknowledgementId: "x".repeat(65_537),
        },
      }),
    ).toEqual({
      installPolicyWarning: { reason: "manual review recommended" },
    });
    expect(readInstallPolicyWarningDetails({ installPolicyWarning: { reason: " " } })).toBe(
      undefined,
    );
  });
});
