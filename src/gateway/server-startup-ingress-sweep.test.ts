import { describe, expect, it, vi } from "vitest";
import { runStartupIngressClaimSweep } from "./server-startup-ingress-sweep.js";

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("runStartupIngressClaimSweep", () => {
  it("logs recovered stale ingress claims", async () => {
    const log = makeLog();
    const recover = vi.fn().mockResolvedValue(2);

    await runStartupIngressClaimSweep({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      log,
      deps: { recoverAllStaleChannelIngressClaims: recover },
    });

    expect(recover).toHaveBeenCalledWith({ stateDir: "/tmp/openclaw-state" });
    expect(log.info).toHaveBeenCalledWith(
      "recovered 2 stale channel ingress claim(s) from startup",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("continues on sweep failures", async () => {
    const log = makeLog();
    const recover = vi.fn().mockRejectedValue(new Error("database locked"));

    await runStartupIngressClaimSweep({
      cfg: {},
      log,
      deps: { recoverAllStaleChannelIngressClaims: recover },
    });

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn.mock.calls[0]?.[0]).toContain(
      "channel ingress claim sweep failed during startup: database locked",
    );
  });
});
