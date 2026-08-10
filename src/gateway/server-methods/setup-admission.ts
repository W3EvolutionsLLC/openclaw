import { resolveStateDir } from "../../config/paths.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE } from "../../infra/file-lock.js";
import { createDeferred } from "../../shared/deferred.js";
import { WizardSession } from "../../wizard/session.js";
import { withSetupMigrationTargetLock } from "../../wizard/setup.migration-snapshot.js";

export const SETUP_ADMISSION_BUSY_MESSAGE =
  "OpenClaw setup is already in progress; try again when it finishes.";

let wizardSessionInProgress = false;

export class SetupAdmissionBusyError extends Error {}

export async function runExclusiveSystemAgentSetupActivation<T>(
  task: () => Promise<T>,
): Promise<T> {
  let admitted = false;
  const admittedTask = async () => {
    admitted = true;
    return await task();
  };
  try {
    return await withSetupMigrationTargetLock(resolveStateDir(), admittedTask, { wait: false });
  } catch (error) {
    if (!admitted && (error as { code?: unknown }).code === FILE_LOCK_TIMEOUT_ERROR_CODE) {
      throw new SetupAdmissionBusyError(SETUP_ADMISSION_BUSY_MESSAGE);
    }
    throw error;
  }
}

export async function createAdmittedWizardSession(
  runner: ConstructorParameters<typeof WizardSession>[0],
  options?: { lockSetupTarget?: boolean; timeoutMs?: number },
): Promise<WizardSession | undefined> {
  if (wizardSessionInProgress) {
    return undefined;
  }
  wizardSessionInProgress = true;
  const runnerSettled = createDeferred();
  let ownerRelease: Promise<void>;
  const releaseProcessAdmission = () => {
    wizardSessionInProgress = false;
  };
  const createSession = () =>
    new WizardSession(runner, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      // The lock owner observes raw runner completion; public settlement waits
      // for this admission's process reservation and target lock to be released.
      awaitOwnerRelease: async () => {
        runnerSettled.resolve(undefined);
        await ownerRelease;
      },
    });
  if (options?.lockSetupTarget !== false) {
    const sessionStarted = createDeferred<WizardSession>();
    let sessionCreated = false;
    const admission = runExclusiveSystemAgentSetupActivation(async () => {
      const session = createSession();
      sessionCreated = true;
      sessionStarted.resolve(session);
      await runnerSettled.promise;
    });
    ownerRelease = admission.finally(releaseProcessAdmission);
    void ownerRelease.catch((error: unknown) => {
      if (!sessionCreated) {
        sessionStarted.reject(error);
      }
    });
    try {
      return await sessionStarted.promise;
    } catch (error) {
      if (error instanceof SetupAdmissionBusyError) {
        return undefined;
      }
      throw error;
    }
  }
  ownerRelease = runnerSettled.promise.finally(releaseProcessAdmission);
  try {
    return createSession();
  } catch (error) {
    releaseProcessAdmission();
    throw error;
  }
}
