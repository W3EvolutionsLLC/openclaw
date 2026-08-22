import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SESSIONS_OPERATION_MAX_TARGETS,
  SessionsOperationSchema,
  SessionsOperationsCreateParamsSchema,
} from "./sessions-operations.js";

const target = {
  key: "agent:main:dashboard:one",
  expectedSessionId: "session-one",
};

describe("session operations schema", () => {
  it("requires exact fenced targets and bounds one bulk message", () => {
    expect(
      Value.Check(SessionsOperationsCreateParamsSchema, {
        requestId: "request-one",
        message: "Report current status.",
        targets: [target],
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionsOperationsCreateParamsSchema, {
        requestId: "request-one",
        message: "Report current status.",
        targets: [{ key: target.key }],
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionsOperationsCreateParamsSchema, {
        requestId: "request-one",
        message: "Report current status.",
        targets: Array.from({ length: SESSIONS_OPERATION_MAX_TARGETS + 1 }, () => target),
      }),
    ).toBe(false);
  });

  it("projects bounded per-target outcomes", () => {
    expect(
      Value.Check(SessionsOperationSchema, {
        id: "operation-one",
        requestId: "request-one",
        kind: "bulk-message",
        status: "needs_attention",
        messagePreview: "Report current status.",
        message: "Report current status.",
        targetCount: 2,
        counts: { pending: 0, accepted: 1, failed: 1 },
        createdAt: 1,
        endedAt: 2,
        targets: [
          { ...target, status: "accepted", runId: "run-one" },
          {
            key: "agent:main:dashboard:two",
            expectedSessionId: "session-two",
            status: "failed",
            error: { code: "INVALID_REQUEST", message: "session changed" },
          },
        ],
      }),
    ).toBe(true);
  });
});
