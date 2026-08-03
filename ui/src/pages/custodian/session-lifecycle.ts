import {
  readSystemAgentSessionInvalidatedErrorDetails,
  type SystemAgentChatParams,
} from "@openclaw/gateway-protocol";
import { inferBasePathFromPathname, routeIdFromPath } from "../../app-route-paths.ts";
import type {
  ApplicationGatewayConnection,
  ApplicationGatewaySnapshot,
} from "../../app/gateway.ts";

export type CustodianSessionVariant = "onboarding" | "new-agent" | "caretaker";

export type CustodianSessionContinuity = {
  key: string;
  ownerKey: string | null;
  processInstanceId: string | null;
};

function readRecordString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : null;
}

/** Mirrors Gateway session ownership so reconnects never adopt another owner or process. */
export function resolveCustodianSessionContinuity(params: {
  connection: ApplicationGatewayConnection;
  snapshot: ApplicationGatewaySnapshot;
  previous: CustodianSessionContinuity | null;
}): CustodianSessionContinuity {
  const hello = params.snapshot.hello;
  const processInstanceId = hello
    ? readRecordString(hello.snapshot, "processInstanceId")
    : (params.previous?.processInstanceId ?? null);
  const previousDeviceOwner = params.previous?.ownerKey?.startsWith("device:")
    ? params.previous.ownerKey
    : null;
  const previousUserOwner =
    !hello && params.previous?.ownerKey?.startsWith("user:") ? params.previous.ownerKey : null;
  const authenticatedUserId =
    params.snapshot.selfUser?.email?.trim() || params.snapshot.selfUser?.id.trim();
  const authenticatedDeviceId = params.snapshot.client?.authenticatedDeviceId?.trim();
  const ownerKey = authenticatedUserId
    ? `user:${authenticatedUserId}`
    : previousUserOwner
      ? previousUserOwner
      : authenticatedDeviceId
        ? `device:${authenticatedDeviceId}`
        : previousDeviceOwner
          ? previousDeviceOwner
          : hello?.server?.connId
            ? `connection:${hello.server.connId}`
            : (params.previous?.ownerKey ?? null);
  const { gatewayUrl, token, password, bootstrapToken } = params.connection;
  return {
    ownerKey,
    processInstanceId,
    key: JSON.stringify([gatewayUrl, token, password, bootstrapToken, ownerKey, processInstanceId]),
  };
}

export function hasCustodianUserInput(params: SystemAgentChatParams): boolean {
  return params.message !== undefined || params.wizardAnswer !== undefined;
}

export function sessionVariant(
  onboarding: boolean,
  newAgentIntent: boolean,
): CustodianSessionVariant {
  return onboarding ? "onboarding" : newAgentIntent ? "new-agent" : "caretaker";
}

export function custodianChatParams(
  variant: CustodianSessionVariant,
  message?: string,
): Pick<SystemAgentChatParams, "welcomeVariant" | "message" | "context"> {
  const variantParams = variant === "caretaker" ? {} : { welcomeVariant: variant };
  if (message === undefined) {
    return variantParams;
  }
  const pathname = window.location.pathname;
  const page = routeIdFromPath(pathname, inferBasePathFromPathname(pathname));
  return { ...variantParams, message, ...(page ? { context: { page } } : {}) };
}

export function isCustodianSessionInvalidatedError(error: unknown): boolean {
  const details =
    error && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
  return readSystemAgentSessionInvalidatedErrorDetails(details) !== undefined;
}
