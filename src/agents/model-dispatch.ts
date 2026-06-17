import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  Model,
} from "../llm/types.js";
import type { MutableAssistantMessageEventStream } from "./stream-compat.js";
import { createStreamIteratorWrapper } from "./stream-iterator-wrapper.js";

export function hasForcedOpenClawTransport(model: Model): boolean {
  return model.dispatch?.forceOpenClawTransport === true;
}

export function resolveModelDispatchAuthProvider(model: Model): string {
  return model.dispatch?.authProvider ?? model.provider;
}

function withBearerAuthorization(
  headers: Record<string, string> | undefined,
  apiKey: string | undefined,
): Record<string, string> | undefined {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!isCredentialHeaderName(name)) {
      next[name] = value;
    }
  }
  if (apiKey?.trim()) {
    next.Authorization = `Bearer ${apiKey}`;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function isCredentialHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    normalized === "api-key" ||
    normalized === "x-api-key" ||
    normalized === "x-goog-api-key" ||
    normalized === "x-amz-security-token" ||
    normalized === "x-amz-credential" ||
    normalized === "x-auth-token" ||
    normalized === "x-access-token" ||
    normalized.endsWith("-api-key") ||
    normalized.endsWith("-auth-token") ||
    normalized.endsWith("-access-token")
  );
}

/**
 * Clones a canonical model for one outbound request. The route metadata never
 * reaches provider payload construction and therefore cannot leak into an
 * upstream provider's request body.
 */
export function prepareModelForDispatch(model: Model, apiKey?: string): Model {
  const route = model.dispatch;
  if (!route) {
    return model;
  }
  const headers =
    route.authHeader === "bearer" ? withBearerAuthorization(model.headers, apiKey) : model.headers;
  return {
    ...model,
    ...(route.upstreamModel && route.upstreamModel !== model.id ? { id: route.upstreamModel } : {}),
    ...(route.authHeader === "bearer" ? { authHeader: true } : {}),
    ...(headers !== model.headers ? { headers } : {}),
    dispatch: undefined,
  };
}

function restoreCanonicalModelIdentity(
  message: AssistantMessage,
  canonicalModelId: string,
): AssistantMessage {
  return message.model === canonicalModelId ? message : { ...message, model: canonicalModelId };
}

function restoreCanonicalModelIdentityInEvent(
  event: AssistantMessageEvent,
  canonicalModelId: string,
): AssistantMessageEvent {
  const next = { ...event };
  if ("partial" in next && next.partial) {
    next.partial = restoreCanonicalModelIdentity(next.partial, canonicalModelId);
  }
  if ("message" in next && next.message) {
    next.message = restoreCanonicalModelIdentity(next.message, canonicalModelId);
  }
  if ("error" in next && next.error) {
    next.error = restoreCanonicalModelIdentity(next.error, canonicalModelId);
  }
  return next;
}

/**
 * Keeps the selected model identity in emitted session messages while the
 * provider transport receives a catalog-specific upstream model id.
 */
export function restoreCanonicalModelIdentityForStream<T extends AssistantMessageEventStreamLike>(
  stream: T,
  canonicalModelId: string,
): T {
  const mutableStream = stream as MutableAssistantMessageEventStream;
  const originalResult = mutableStream.result.bind(mutableStream);
  mutableStream.result = async () =>
    restoreCanonicalModelIdentity(await originalResult(), canonicalModelId);

  const originalAsyncIterator = mutableStream[Symbol.asyncIterator].bind(mutableStream);
  (mutableStream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[
    Symbol.asyncIterator
  ] = function () {
    const iterator = originalAsyncIterator();
    return createStreamIteratorWrapper({
      iterator,
      next: async (streamIterator) => {
        const result = await streamIterator.next();
        return result.done
          ? result
          : {
              done: false as const,
              value: restoreCanonicalModelIdentityInEvent(result.value, canonicalModelId),
            };
      },
    });
  };
  return mutableStream as T;
}
