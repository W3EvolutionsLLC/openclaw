import { withTimeout } from "../utils/with-timeout.js";

type PausableOnboardingInstallWatchdog = {
  pauseWhile<T>(operation: () => Promise<T>): Promise<T>;
};

type TaskOutcome<T> = { kind: "completed"; value: T } | { kind: "failed"; error: unknown };

/** Runs install work with an active-time budget that excludes interactive review prompts. */
export async function withPausableOnboardingInstallWatchdog<T>(params: {
  operation: (watchdog: PausableOnboardingInstallWatchdog) => Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  let pauseDepth = 0;
  let stateVersion = 0;
  let stateWaiters: Array<() => void> = [];
  const signalStateChange = () => {
    stateVersion += 1;
    const waiters = stateWaiters;
    stateWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  };
  const waitForStateChange = (version: number): Promise<void> => {
    if (stateVersion !== version) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      stateWaiters.push(resolve);
    });
  };
  const watchdog: PausableOnboardingInstallWatchdog = {
    pauseWhile: async (operation) => {
      pauseDepth += 1;
      if (pauseDepth === 1) {
        signalStateChange();
      }
      try {
        return await operation();
      } finally {
        pauseDepth -= 1;
        if (pauseDepth === 0) {
          signalStateChange();
        }
      }
    },
  };
  const task: Promise<TaskOutcome<T>> = Promise.resolve()
    .then(() => params.operation(watchdog))
    .then(
      (value) => ({ kind: "completed", value }),
      (error: unknown) => ({ kind: "failed", error }),
    );
  let remainingMs = params.timeoutMs;

  while (true) {
    if (pauseDepth > 0) {
      const version = stateVersion;
      const outcome = await Promise.race([
        task,
        waitForStateChange(version).then(() => ({ kind: "state-changed" as const })),
      ]);
      if (outcome.kind === "completed") {
        return outcome.value;
      }
      if (outcome.kind === "failed") {
        throw outcome.error;
      }
      continue;
    }
    if (remainingMs <= 0) {
      throw new Error("timeout");
    }
    const version = stateVersion;
    const startedAt = Date.now();
    const outcome = await withTimeout(
      Promise.race([
        task,
        waitForStateChange(version).then(() => ({ kind: "state-changed" as const })),
      ]),
      remainingMs,
    );
    if (outcome.kind === "completed") {
      return outcome.value;
    }
    if (outcome.kind === "failed") {
      throw outcome.error;
    }
    remainingMs -= Math.max(0, Date.now() - startedAt);
  }
}
