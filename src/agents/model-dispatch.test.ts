import { describe, expect, it } from "vitest";
import type { Model } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  hasForcedOpenClawTransport,
  prepareModelForDispatch,
  restoreCanonicalModelIdentityForStream,
  resolveModelDispatchAuthProvider,
} from "./model-dispatch.js";

function buildModel(): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://router.example/v1/native/anthropic",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_768,
    headers: {
      Authorization: "Bearer stale-token",
      "x-goog-api-key": "direct-google-key",
      "api-key": "direct-azure-key",
      "X-Request-ID": "request-1",
    },
    dispatch: {
      authProvider: "clawrouter",
      authHeader: "bearer",
      forceOpenClawTransport: true,
      upstreamModel: "claude-sonnet-4-6-20260217",
    },
  };
}

describe("model dispatch", () => {
  it("preserves canonical identity while preparing only the outbound request", () => {
    const model = buildModel();

    expect(hasForcedOpenClawTransport(model)).toBe(true);
    expect(resolveModelDispatchAuthProvider(model)).toBe("clawrouter");

    const requestModel = prepareModelForDispatch(model, "router-token");

    expect(model).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      dispatch: { authProvider: "clawrouter" },
    });
    expect(requestModel).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-4-6-20260217",
      authHeader: true,
      headers: {
        Authorization: "Bearer router-token",
        "X-Request-ID": "request-1",
      },
      dispatch: undefined,
    });
    expect(requestModel.headers).not.toHaveProperty("x-goog-api-key");
    expect(requestModel.headers).not.toHaveProperty("api-key");
  });

  it("restores canonical identity in streamed and persisted assistant messages", async () => {
    const stream = restoreCanonicalModelIdentityForStream(
      createAssistantMessageEventStream(),
      "claude-sonnet-4-6",
    );
    const upstreamMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "hello" }],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "claude-sonnet-4-6-20260217",
      responseModel: "claude-sonnet-4-6-20260217",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: 1,
    };
    stream.push({ type: "start", partial: upstreamMessage });
    stream.push({ type: "done", reason: "stop", message: upstreamMessage });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "start",
        partial: expect.objectContaining({
          model: "claude-sonnet-4-6",
          responseModel: "claude-sonnet-4-6-20260217",
        }),
      }),
      expect.objectContaining({
        type: "done",
        message: expect.objectContaining({
          model: "claude-sonnet-4-6",
          responseModel: "claude-sonnet-4-6-20260217",
        }),
      }),
    ]);
    await expect(stream.result()).resolves.toMatchObject({
      model: "claude-sonnet-4-6",
      responseModel: "claude-sonnet-4-6-20260217",
    });
  });
});
