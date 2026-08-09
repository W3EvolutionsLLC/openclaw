// Resolves the Gateway URL a pairing route advertises, including the pinned
// single-route resolution the Control UI wizard relies on.
import type os from "node:os";
import { isCarrierGradeNatIpv4Address } from "@openclaw/net-policy/ip";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeWebSocketProtocol } from "../gateway/net.js";
import { resolveAdvertisedLanHost } from "../infra/advertised-lan-host.js";
import {
  pickMatchingExternalInterfaceAddress,
  safeNetworkInterfaces,
} from "../infra/network-interfaces.js";
import { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";
import { isPairingCleartextAllowedHost } from "../shared/pairing-connectivity-urls.js";
import { resolveConfiguredTailscaleGatewayUrlsWithRunner } from "../shared/tailscale-status.js";

export type PairingConnectivityMode = "lan" | "tailscale" | "public";

type PairingConnectivityCommandResult = {
  code: number | null;
  stdout: string;
  errorCode?: string;
};

export type PairingConnectivityCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv },
) => Promise<PairingConnectivityCommandResult>;

type PairingGatewayRouteOptions = {
  env: NodeJS.ProcessEnv;
  networkInterfaces: () => ReturnType<typeof os.networkInterfaces>;
  /**
   * Pins resolution to one planned route. Without it the historic precedence
   * (public URL, remote, Tailscale, then bind) applies, which would let a
   * configured route outrank the one a caller inspected and verified.
   */
  routeMode?: PairingConnectivityMode;
  publicUrl?: string;
  preferRemoteUrl?: boolean;
  forceSecure?: boolean;
  runCommandWithTimeout?: PairingConnectivityCommandRunner;
};

type PairingGatewayRoute = {
  url?: string;
  urls?: string[];
  source?: string;
  error?: string;
};

const GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE = /^(?:https?|wss?):(?!\/\/)/i;
const SCHEME_LIKE_PATH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\//;

function describeSecureMobilePairingFix(source?: string): string {
  const sourceNote = source ? ` Resolved source: ${source}.` : "";
  return (
    "Tailscale and public mobile pairing require a secure gateway URL (wss://) or Tailscale Serve/Funnel." +
    sourceNote +
    " Fix: use a private LAN address, prefer gateway.tailscale.mode=serve, or set " +
    "gateway.remote.url / plugins.entries.device-pair.config.publicUrl to a wss:// URL. " +
    "ws:// is only valid for localhost, private LAN addresses, .local hosts, or the Android emulator."
  );
}

export function validateMobilePairingUrl(url: string, source?: string): string | null {
  try {
    const parsed = new URL(url);
    const protocol = normalizeWebSocketProtocol(parsed.protocol);
    return protocol === "wss:" ||
      (protocol === "ws:" && isPairingCleartextAllowedHost(parsed.hostname))
      ? null
      : describeSecureMobilePairingFix(source);
  } catch {
    return "Resolved mobile pairing URL is invalid.";
  }
}

function parseNormalizedGatewayUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || !parsed.hostname) {
      return null;
    }
    const normalizedScheme = normalizeWebSocketProtocol(parsed.protocol).slice(0, -1);
    if (normalizedScheme !== "ws" && normalizedScheme !== "wss") {
      return null;
    }
    return `${normalizedScheme}://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return null;
  }
}

function normalizeUrl(raw: string, schemeFallback: "ws" | "wss"): string | null {
  const trimmed = raw.trim();
  if (!trimmed || GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE.test(trimmed)) {
    return null;
  }
  const parsed = parseNormalizedGatewayUrl(trimmed);
  if (parsed) {
    return parsed;
  }
  if (trimmed.includes("://") || SCHEME_LIKE_PATH_RE.test(trimmed)) {
    return null;
  }
  const hostPort = normalizeOptionalString(trimmed.split("/", 1)[0]) ?? "";
  return hostPort ? parseNormalizedGatewayUrl(`${schemeFallback}://${hostPort}`) : null;
}

export function resolveScheme(cfg: OpenClawConfig, forceSecure?: boolean): "ws" | "wss" {
  return forceSecure || cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
}

function pickTailnetIpv4(networkInterfaces: () => ReturnType<typeof os.networkInterfaces>) {
  return (
    pickMatchingExternalInterfaceAddress(safeNetworkInterfaces(networkInterfaces), {
      family: "IPv4",
      matches: isCarrierGradeNatIpv4Address,
    }) ?? null
  );
}

async function resolveTailscaleGatewayUrl(
  cfg: OpenClawConfig,
  port: number,
  runCommandWithTimeout: PairingConnectivityCommandRunner | undefined,
): Promise<PairingGatewayRoute> {
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode !== "serve" && tailscaleMode !== "funnel") {
    return { error: "Tailscale is not configured for gateway access." };
  }
  const urls = await resolveConfiguredTailscaleGatewayUrlsWithRunner(
    {
      mode: tailscaleMode,
      gatewayPort: port,
      ...(tailscaleMode === "serve" && cfg.gateway?.tailscale?.serviceName
        ? { serviceName: cfg.gateway.tailscale.serviceName }
        : {}),
    },
    runCommandWithTimeout,
  );
  return urls[0]
    ? { url: urls[0], urls, source: `gateway.tailscale.mode=${tailscaleMode}` }
    : { error: `Configured Tailscale ${tailscaleMode} route is not available.` };
}

async function resolveBoundGatewayUrl(
  cfg: OpenClawConfig,
  scheme: "ws" | "wss",
  port: number,
  opts: Pick<PairingGatewayRouteOptions, "networkInterfaces" | "runCommandWithTimeout">,
): Promise<PairingGatewayRoute> {
  const advertisedLanHost =
    cfg.gateway?.bind === "lan"
      ? await resolveAdvertisedLanHost({
          networkInterfaces: opts.networkInterfaces,
          runCommandWithTimeout: opts.runCommandWithTimeout,
        })
      : null;
  return (
    resolveGatewayBindUrl({
      bind: cfg.gateway?.bind,
      customBindHost: cfg.gateway?.customBindHost,
      scheme,
      port,
      pickTailnetHost: () => pickTailnetIpv4(opts.networkInterfaces),
      pickLanHost: () => advertisedLanHost,
    }) ?? {
      error:
        "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.",
    }
  );
}

export async function resolveGatewayUrl(
  cfg: OpenClawConfig,
  opts: PairingGatewayRouteOptions,
): Promise<PairingGatewayRoute> {
  const scheme = resolveScheme(cfg, opts.forceSecure);
  const port = resolveGatewayPort(cfg, opts.env);
  const operatorPublicUrl = normalizeOptionalString(opts.publicUrl);
  if (opts.routeMode === "public" || (!opts.routeMode && operatorPublicUrl)) {
    const url = operatorPublicUrl ? normalizeUrl(operatorPublicUrl, scheme) : null;
    return url
      ? { url, source: "plugins.entries.device-pair.config.publicUrl" }
      : { error: "Configured publicUrl is invalid." };
  }
  if (opts.routeMode === "tailscale") {
    return await resolveTailscaleGatewayUrl(cfg, port, opts.runCommandWithTimeout);
  }
  if (opts.routeMode === "lan") {
    return await resolveBoundGatewayUrl(cfg, scheme, port, opts);
  }
  const remoteRaw = normalizeOptionalString(cfg.gateway?.remote?.url);
  const remoteUrl = remoteRaw ? normalizeUrl(remoteRaw, scheme) : null;
  if (remoteRaw && !remoteUrl) {
    return { error: "Configured gateway.remote.url is invalid." };
  }
  if (opts.preferRemoteUrl && remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }
  if ((cfg.gateway?.tailscale?.mode ?? "off") !== "off") {
    return await resolveTailscaleGatewayUrl(cfg, port, opts.runCommandWithTimeout);
  }
  if (remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }
  return await resolveBoundGatewayUrl(cfg, scheme, port, opts);
}
