import { recoverAllStaleChannelIngressClaims } from "../channels/message/ingress-queue.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";

type StartupIngressSweepLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

type StartupIngressSweepDeps = {
  recoverAllStaleChannelIngressClaims: typeof recoverAllStaleChannelIngressClaims;
};

export async function runStartupIngressClaimSweep(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: StartupIngressSweepLog;
  deps?: StartupIngressSweepDeps;
}): Promise<void> {
  try {
    const recovered = await (
      params.deps?.recoverAllStaleChannelIngressClaims ?? recoverAllStaleChannelIngressClaims
    )({
      stateDir: params.env?.OPENCLAW_STATE_DIR,
    });
    if (recovered > 0) {
      params.log.info(`recovered ${recovered} stale channel ingress claim(s) from startup`);
    }
  } catch (err) {
    params.log.warn(
      `channel ingress claim sweep failed during startup: ${formatErrorMessage(err)}`,
    );
  }
}
