import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ErrorShapeSchema } from "./frames.js";
import { NonEmptyString } from "./primitives.js";
import { SESSIONS_OPERATION_MAX_TARGETS } from "./sessions-operations-constants.js";

export { SESSIONS_OPERATION_MAX_TARGETS };

export const SessionsOperationTargetSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  expectedSessionId: NonEmptyString,
});

export const SessionsOperationTargetStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("accepted"),
  Type.Literal("failed"),
]);

export const SessionsOperationTargetOutcomeSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  expectedSessionId: NonEmptyString,
  status: SessionsOperationTargetStatusSchema,
  runId: Type.Optional(NonEmptyString),
  error: Type.Optional(ErrorShapeSchema),
});

export const SessionsOperationStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("needs_attention"),
  Type.Literal("interrupted"),
]);

export const SessionsOperationCountsSchema = closedObject({
  pending: Type.Integer({ minimum: 0 }),
  accepted: Type.Integer({ minimum: 0 }),
  failed: Type.Integer({ minimum: 0 }),
});

export const SessionsOperationSummarySchema = closedObject({
  id: NonEmptyString,
  requestId: NonEmptyString,
  kind: Type.Literal("bulk-message"),
  status: SessionsOperationStatusSchema,
  messagePreview: Type.String({ maxLength: 160 }),
  targetCount: Type.Integer({ minimum: 1, maximum: SESSIONS_OPERATION_MAX_TARGETS }),
  counts: SessionsOperationCountsSchema,
  createdAt: Type.Integer({ minimum: 0 }),
  startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  retryOf: Type.Optional(NonEmptyString),
});

export const SessionsOperationSchema = closedObject({
  ...SessionsOperationSummarySchema.properties,
  message: Type.String({ minLength: 1, maxLength: 20_000 }),
  targets: Type.Array(SessionsOperationTargetOutcomeSchema, {
    minItems: 1,
    maxItems: SESSIONS_OPERATION_MAX_TARGETS,
  }),
});

export const SessionsOperationsCreateParamsSchema = closedObject({
  requestId: NonEmptyString,
  message: Type.String({ minLength: 1, maxLength: 20_000 }),
  targets: Type.Array(SessionsOperationTargetSchema, {
    minItems: 1,
    maxItems: SESSIONS_OPERATION_MAX_TARGETS,
  }),
});

export const SessionsOperationsCreateResultSchema = closedObject({
  operation: SessionsOperationSchema,
});

export const SessionsOperationsListParamsSchema = closedObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const SessionsOperationsListResultSchema = closedObject({
  operations: Type.Array(SessionsOperationSummarySchema, { maxItems: 100 }),
});

export const SessionsOperationsGetParamsSchema = closedObject({ id: NonEmptyString });
export const SessionsOperationsGetResultSchema = closedObject({
  operation: SessionsOperationSchema,
});

export const SessionsOperationsRetryParamsSchema = closedObject({
  id: NonEmptyString,
  requestId: NonEmptyString,
});
export const SessionsOperationsRetryResultSchema = closedObject({
  operation: SessionsOperationSchema,
});

export type SessionsOperationTarget = Static<typeof SessionsOperationTargetSchema>;
export type SessionsOperationTargetOutcome = Static<typeof SessionsOperationTargetOutcomeSchema>;
export type SessionsOperationStatus = Static<typeof SessionsOperationStatusSchema>;
export type SessionsOperationCounts = Static<typeof SessionsOperationCountsSchema>;
export type SessionsOperationSummary = Static<typeof SessionsOperationSummarySchema>;
export type SessionsOperation = Static<typeof SessionsOperationSchema>;
export type SessionsOperationsCreateParams = Static<typeof SessionsOperationsCreateParamsSchema>;
export type SessionsOperationsCreateResult = Static<typeof SessionsOperationsCreateResultSchema>;
export type SessionsOperationsListParams = Static<typeof SessionsOperationsListParamsSchema>;
export type SessionsOperationsListResult = Static<typeof SessionsOperationsListResultSchema>;
export type SessionsOperationsGetParams = Static<typeof SessionsOperationsGetParamsSchema>;
export type SessionsOperationsGetResult = Static<typeof SessionsOperationsGetResultSchema>;
export type SessionsOperationsRetryParams = Static<typeof SessionsOperationsRetryParamsSchema>;
export type SessionsOperationsRetryResult = Static<typeof SessionsOperationsRetryResultSchema>;
