import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withSetupMigrationTargetLock } from "../../wizard/setup.migration-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});

const mocks = vi.hoisted(() => ({ stateDir: "" }));

vi.mock("../../config/paths.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/paths.js")>("../../config/paths.js")),
  resolveStateDir: () => mocks.stateDir,
}));

import {
  createAdmittedWizardSession,
  runExclusiveSystemAgentSetupActivation,
} from "./setup-admission.js";

describe("setup admission", () => {
  beforeEach(() => {
    mocks.stateDir = tempDirs.make("openclaw-setup-admission-");
  });

  it("rejects concurrent work instead of queueing it", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const events: string[] = [];
    const first = runExclusiveSystemAgentSetupActivation(async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    await firstStarted.promise;

    const secondTask = vi.fn(async () => events.push("second:start"));
    await expect(runExclusiveSystemAgentSetupActivation(secondTask)).rejects.toThrow(
      "setup is already in progress",
    );
    expect(secondTask).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await first;
    await runExclusiveSystemAgentSetupActivation(async () => events.push("third:start"));
    expect(events).toEqual(["first:start", "first:end", "third:start"]);
  });

  it("releases the admission lease when work fails", async () => {
    await expect(
      runExclusiveSystemAgentSetupActivation(async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");

    await expect(runExclusiveSystemAgentSetupActivation(async () => "ok")).resolves.toBe("ok");
  });

  it("does not misclassify a task's own file-lock timeout as setup contention", async () => {
    const taskError = Object.assign(new Error("config lock timed out"), {
      code: "file_lock_timeout",
    });

    await expect(
      runExclusiveSystemAgentSetupActivation(async () => {
        throw taskError;
      }),
    ).rejects.toBe(taskError);
  });

  it("settles an admitted session only after releasing setup ownership", async () => {
    const releaseRunner = createDeferred();
    const session = await createAdmittedWizardSession(async () => {
      await releaseRunner.promise;
    });
    expect(session).toBeDefined();

    await expect(createAdmittedWizardSession(async () => {})).resolves.toBeUndefined();

    releaseRunner.resolve();
    await session?.whenSettled();
    await expect(runExclusiveSystemAgentSetupActivation(async () => "ok")).resolves.toBe("ok");

    const replacement = await createAdmittedWizardSession(async () => {});
    expect(replacement).toBeDefined();
    await replacement?.whenSettled();
  });

  it("rejects settlement when the canonical target lock cannot be released", async () => {
    const releaseRunner = createDeferred();
    const session = await createAdmittedWizardSession(async () => {
      await releaseRunner.promise;
    });
    if (!session) {
      throw new Error("expected admitted session");
    }
    const releaseError = new Error("target lock release failed");
    __setFsSafeTestHooksForTest({
      beforeSidecarLockSnapshotOpen: () => {
        throw releaseError;
      },
    });

    const settlement = expect(session.whenSettled()).rejects.toBe(releaseError);
    releaseRunner.resolve();
    await settlement;
    expect(session.isSettled()).toBe(true);
    expect(session.getStatus()).toBe("error");
    expect(session.getError()).toContain(releaseError.message);

    __setFsSafeTestHooksForTest(undefined);
    const channel = await createAdmittedWizardSession(async () => {}, {
      lockSetupTarget: false,
    });
    expect(channel).toBeDefined();
    await channel?.whenSettled();

    const structuredTask = vi.fn(async () => "unexpected");
    await expect(runExclusiveSystemAgentSetupActivation(structuredTask)).rejects.toThrow(
      "setup is already in progress",
    );
    expect(structuredTask).not.toHaveBeenCalled();
  });

  it("releases an admitted session lease when its runner fails", async () => {
    const failed = await createAdmittedWizardSession(async () => {
      throw new Error("runner failed");
    });
    await failed?.whenSettled();
    expect(failed?.getError()).toContain("runner failed");

    const replacement = await createAdmittedWizardSession(async () => {});
    expect(replacement).toBeDefined();
    await replacement?.whenSettled();
  });

  it("reserves wizard admission while setup waits to acquire its target lock", async () => {
    const lockAcquired = createDeferred();
    const releaseLock = createDeferred();
    const lockOwner = withSetupMigrationTargetLock(mocks.stateDir, async () => {
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    const setupAttempt = createAdmittedWizardSession(async () => {});
    const channelRunner = vi.fn(async () => {});
    await expect(
      createAdmittedWizardSession(channelRunner, { lockSetupTarget: false }),
    ).resolves.toBeUndefined();
    expect(channelRunner).not.toHaveBeenCalled();
    await expect(setupAttempt).resolves.toBeUndefined();

    releaseLock.resolve();
    await lockOwner;
  });

  it("rejects Gateway setup while the canonical onboarding target lock is held", async () => {
    const lockAcquired = createDeferred();
    const releaseLock = createDeferred();
    const lockOwner = withSetupMigrationTargetLock(mocks.stateDir, async () => {
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    const task = vi.fn(async () => "unexpected");
    await expect(runExclusiveSystemAgentSetupActivation(task)).rejects.toThrow(
      "setup is already in progress",
    );
    expect(task).not.toHaveBeenCalled();

    releaseLock.resolve();
    await lockOwner;
    await expect(runExclusiveSystemAgentSetupActivation(async () => "ok")).resolves.toBe("ok");
  });
});
