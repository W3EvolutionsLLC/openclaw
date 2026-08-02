import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installManagedPluginSource: vi.fn(),
}));

vi.mock("../../plugins/management-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/management-service.js")>()),
  installManagedPluginSource: mocks.installManagedPluginSource,
}));

const { installPluginFromPluginsCommand } = await import("./commands-plugins-install.js");

describe("chat plugin install policy warnings", () => {
  it("hands acknowledgement off to the trusted local CLI with full warning details", async () => {
    mocks.installManagedPluginSource.mockResolvedValueOnce({
      ok: false,
      code: "install_policy_acknowledgement_required",
      error: "Manual review required.",
      installPolicyWarning: {
        reason: "Manual review required.",
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "warn",
            message: "The plugin launches a child process.",
          },
        ],
      },
    });

    const result = await installPluginFromPluginsCommand({
      raw: "clawhub:@openclaw/demo@1.0.0",
      force: false,
      snapshot: {
        baseHash: "base-hash",
        config: {},
        writeOptions: {},
      },
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(
        /Manual review required\.[\s\S]*dangerous-exec[\s\S]*--dangerously-force-unsafe-install[\s\S]*trusted shell/u,
      ),
    });
  });
});
