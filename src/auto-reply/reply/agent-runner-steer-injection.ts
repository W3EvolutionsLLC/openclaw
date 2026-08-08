import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
} from "../../agents/embedded-agent-runner/runs.js";
import { logVerbose } from "../../globals.js";
import {
  type RunReplyAgentParams,
  scheduleFollowupDrainAfterReplyOperationClear,
} from "./agent-runner-core.js";
import { finalizeAcceptedSteer } from "./agent-runner-steer-adoption.js";
import {
  admitFollowupRunLifecycle,
  parkSteerCandidate,
  resolveFollowupAbortSignal,
  scheduleFollowupDrain,
} from "./queue.js";
import * as replyRunState from "./reply-operation-run-state.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { refreshReplyOperationTyping } from "./reply-run-typing.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";
import type { createTypingSignaler } from "./typing-mode.js";

type SteerInjectionParams = Pick<
  RunReplyAgentParams,
  "followupRun" | "queueKey" | "resolvedQueue" | "sessionCtx" | "sessionKey" | "typing"
> & {
  providedReplyOperation: RunReplyAgentParams["replyOperation"];
  replyOperationRunState: ReturnType<typeof replyRunState.resolveReplyOperationRunState>;
  queuedRunFollowupTurn: Parameters<typeof parkSteerCandidate>[3];
  releaseAdmissionTicket: () => void;
  touchActiveSessionEntry: () => Promise<void>;
  restartRecoverySourceTurnId: string | undefined;
  runId: unknown;
  typingSignals: ReturnType<typeof createTypingSignaler>;
};

/**
 * Attempts to steer an inbound message into the session's active run. Every
 * outcome — parked cancellation, followup fallback, rejected injection, or
 * accepted steer — resolves this turn to `undefined`; the queued followup
 * machinery owns any later delivery.
 */
export async function attemptActiveRunSteerInjection(
  params: SteerInjectionParams,
): Promise<undefined> {
  const {
    followupRun,
    queueKey,
    resolvedQueue,
    sessionCtx,
    sessionKey,
    typing,
    providedReplyOperation,
    replyOperationRunState,
    queuedRunFollowupTurn,
    releaseAdmissionTicket,
    touchActiveSessionEntry,
    restartRecoverySourceTurnId,
    typingSignals,
  } = params;
  // Steer against the operation that owns THIS session's run slot. A native
  // command continuation whose slot adoption was skipped (#104844) still
  // carries a source-keyed reservation; steering by its stale sessionId
  // would miss the live target run.
  const registeredReplyOperation = sessionKey ? replyRunRegistry.get(sessionKey) : undefined;
  const activeReplyOperation =
    providedReplyOperation?.key === sessionKey
      ? providedReplyOperation
      : (registeredReplyOperation ?? providedReplyOperation);
  const steerSessionId = activeReplyOperation?.sessionId ?? followupRun.run.sessionId;
  replyRunState.bindQueueDispositionToRunState(followupRun, replyOperationRunState);
  const parked = parkSteerCandidate(queueKey, followupRun, resolvedQueue, queuedRunFollowupTurn);
  if (!parked) {
    releaseAdmissionTicket();
    typing.cleanup();
    return undefined;
  }
  const scheduleParkedFallback = () => {
    const owner = replyRunRegistry.get(queueKey);
    if (owner) {
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: owner,
        queueKey,
        runFollowup: queuedRunFollowupTurn,
      });
    } else {
      scheduleFollowupDrain(queueKey, queuedRunFollowupTurn);
    }
  };
  scheduleParkedFallback();
  releaseAdmissionTicket();
  try {
    const admission = await parked.admit();
    if (admission === "cancelled") {
      parked.consume();
      typing.cleanup();
      return undefined;
    }
    if (admission === "fallback") {
      parked.fallback();
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "accepted", mode: "followup" };
      }
      await touchActiveSessionEntry();
      typing.cleanup();
      return undefined;
    }
    // Channel dispatch normally stamps the route-scoped source id. Internal
    // callers can derive the same per-message identity from the prepared turn.
    const steerRunId = expectDefined(
      restartRecoverySourceTurnId ??
        buildChannelSourceTurnId({
          provider:
            followupRun.originatingChannel ??
            followupRun.run.messageProvider ??
            sessionCtx.Provider,
          accountId:
            followupRun.originatingAccountId ??
            followupRun.run.agentAccountId ??
            sessionCtx.AccountId,
          conversationId:
            followupRun.originatingTo ??
            followupRun.originatingChatId ??
            sessionKey ??
            followupRun.run.sessionKey,
          messageId: followupRun.messageId ?? sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
        }) ??
        normalizeOptionalString(params.runId),
      "steered turn id",
    );
    const steerOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      steerSessionId,
      followupRun.prompt,
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        ...(followupRun.images?.length ? { images: followupRun.images } : {}),
        ...(followupRun.imageOrder?.length ? { imageOrder: followupRun.imageOrder } : {}),
        ...(followupRun.media?.length ? { media: followupRun.media } : {}),
        waitForTranscriptCommit: true,
        queueIdentity: steerRunId,
        abortSignal: resolveFollowupAbortSignal(followupRun),
        onQueueAccepted: parked.accepted,
        ...(resolvedQueue.debounceMs !== undefined ? { debounceMs: resolvedQueue.debounceMs } : {}),
        ...(followupRun.run.sourceReplyDeliveryMode
          ? { sourceReplyDeliveryMode: followupRun.run.sourceReplyDeliveryMode }
          : {}),
        taskSuggestionDeliveryMode: followupRun.run.taskSuggestionDeliveryMode,
        ...(followupRun.userTurnTranscriptRecorder
          ? { userTurnTranscriptRecorder: followupRun.userTurnTranscriptRecorder }
          : {}),
      },
    );
    if (!steerOutcome.queued) {
      parked.fallback();
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "accepted", mode: "followup" };
      }
      const summary = formatEmbeddedAgentQueueFailureSummary(steerOutcome);
      logVerbose(`queue: active session ${steerSessionId} rejected steering injection: ${summary}`);
      await touchActiveSessionEntry();
      typing.cleanup();
      return undefined;
    }
    const adoptionDisposition = await finalizeAcceptedSteer({
      activeReplyOperation,
      abortKey: sessionKey ?? queueKey,
      cleanupTyping: () => typing.cleanup(),
      errorMessage: steerOutcome.errorMessage,
      onAdopted: () => admitFollowupRunLifecycle(followupRun),
      replyOperationRunState,
      steerSessionId,
      transcriptCommit: steerOutcome.transcriptCommit,
    });
    parked.consume();
    if (adoptionDisposition === "stop") {
      return undefined;
    }
    if (followupRun.currentInboundAudio === true) {
      activeReplyOperation?.markAcceptedSteeredInboundAudio();
    }
    if (activeReplyOperation) {
      await refreshReplyOperationTyping(activeReplyOperation, {
        startIfIdle: typingSignals.shouldStartImmediately,
      });
    }
    await touchActiveSessionEntry();
    typing.cleanup();
    return undefined;
  } catch (error) {
    if (resolveFollowupAbortSignal(followupRun)?.aborted) {
      parked.consume();
    } else {
      parked.fallback();
    }
    throw error;
  } finally {
    if (followupRun.steerPending) {
      if (resolveFollowupAbortSignal(followupRun)?.aborted) {
        parked.consume();
      } else {
        parked.fallback();
      }
    }
  }
}
