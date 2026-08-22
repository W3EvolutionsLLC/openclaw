import { describe, expect, it } from "vitest";
import { SESSION_BULK_MESSAGE_TASK_KIND } from "../tasks/session-bulk-message-task-contract.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { GatewayClient } from "./server-methods/types.js";
import { sessionBulkMessageOwnerKey } from "./session-bulk-message-operation-access.js";
import { canAccessTaskRequesterSession } from "./task-session-access.js";

function client(profileId: string): GatewayClient {
  return {
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
  } as GatewayClient;
}

function operationTask(ownerKey: string): TaskRecord {
  return {
    taskId: "bulk-private",
    runtime: "cli",
    taskKind: SESSION_BULK_MESSAGE_TASK_KIND,
    requesterSessionKey: "",
    ownerKey,
    scopeKind: "system",
    task: "Private operation message.",
    status: "succeeded",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 1,
  };
}

describe("task session access", () => {
  it("keeps bulk-message ledger records private to their creating profile", () => {
    const alice = client("alice");
    const bob = client("bob");
    const task = operationTask(sessionBulkMessageOwnerKey(alice));

    expect(canAccessTaskRequesterSession({ cfg: {}, client: alice, task })).toBe(true);
    expect(canAccessTaskRequesterSession({ cfg: {}, client: bob, task })).toBe(false);
  });
});
