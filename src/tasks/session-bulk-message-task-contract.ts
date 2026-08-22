import type { TaskRecord } from "./task-registry.types.js";

export const SESSION_BULK_MESSAGE_TASK_KIND = "sessions.bulk-message";
export const SESSION_BULK_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const SESSION_BULK_MESSAGE_INTERRUPTED_ERROR =
  "Gateway restarted during bulk session message";

export function isSessionBulkMessageTask(task: Pick<TaskRecord, "taskKind">): boolean {
  return task.taskKind === SESSION_BULK_MESSAGE_TASK_KIND;
}
