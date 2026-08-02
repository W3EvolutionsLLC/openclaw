import { afterEach, describe, expect, it, vi } from "vitest";
import { withPausableOnboardingInstallWatchdog } from "./onboarding-install-watchdog.js";

describe("withPausableOnboardingInstallWatchdog", () => {
  afterEach(() => vi.useRealTimers());

  it("excludes interactive review time from the timeout budget", async () => {
    vi.useFakeTimers();
    let finishReview: (() => void) | undefined;
    const result = withPausableOnboardingInstallWatchdog({
      timeoutMs: 100,
      operation: async (watchdog) => {
        await watchdog.pauseWhile(
          async () =>
            await new Promise<void>((resolve) => {
              finishReview = resolve;
            }),
        );
        return "installed";
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(finishReview).toBeDefined();
    finishReview?.();

    await expect(result).resolves.toBe("installed");
  });

  it("still rejects install work that exhausts the active timeout budget", async () => {
    vi.useFakeTimers();
    const result = withPausableOnboardingInstallWatchdog({
      timeoutMs: 100,
      operation: async () => await new Promise<never>(() => {}),
    });
    const rejection = expect(result).rejects.toThrow("timeout");

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
  });
});
