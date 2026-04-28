import type { GatewayProbeResult } from "../../gateway/probe.js";
import { isLoopbackIpAddress } from "../../shared/net/ip.js";

export function isLoopbackGatewayUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const unbracketed =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
  } catch {
    return false;
  }
}

export function shouldTryLocalStatusRpcFallback(params: {
  gatewayMode: "local" | "remote";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult | null;
}): params is {
  gatewayMode: "local";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult;
} {
  if (
    params.gatewayMode !== "local" ||
    !params.gatewayProbe ||
    params.gatewayProbe.ok ||
    !isLoopbackGatewayUrl(params.gatewayUrl)
  ) {
    return false;
  }
  const error = params.gatewayProbe.error?.toLowerCase() ?? "";
  return error.includes("timeout") || params.gatewayProbe.auth?.capability === "unknown";
}

export async function applyLocalStatusRpcFallback(params: {
  gatewayMode: "local" | "remote";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult | null;
  callStatus: () => Promise<unknown>;
}): Promise<GatewayProbeResult | null> {
  if (!shouldTryLocalStatusRpcFallback(params)) {
    return params.gatewayProbe;
  }
  const status = await params.callStatus().catch(() => null);
  if (!status) {
    return params.gatewayProbe;
  }
  const auth = params.gatewayProbe.auth ?? {
    role: null,
    scopes: [],
    capability: "unknown" as const,
  };
  return {
    ...params.gatewayProbe,
    ok: true,
    status,
    auth:
      auth.capability === "unknown"
        ? {
            ...auth,
            capability: "read_only",
          }
        : auth,
  };
}
