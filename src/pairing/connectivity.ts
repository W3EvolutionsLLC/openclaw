// Pairing connectivity owns route, transport, and access planning before token issuance.
import os from "node:os";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import {
  assertExplicitGatewayAuthModeWhenBothConfigured,
  hasAmbiguousGatewayAuthModeConfig,
} from "../gateway/auth-mode-policy.js";
import { resolveAdvertisedLanHost } from "../infra/advertised-lan-host.js";
import {
  deviceBootstrapProfilesEqual,
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfileInput,
} from "../shared/device-bootstrap-profile.js";
import {
  isFullAccessPairingConnectivityUrl,
  isPrivatePairingLanHost,
  normalizePairingConnectivityHost,
  projectPairingConnectivityUrls,
} from "../shared/pairing-connectivity-urls.js";
import {
  inspectTailscaleConnectivityWithRunner,
  selectTailscaleGatewayUrls,
  type TailscaleConnectivityInspection,
} from "../shared/tailscale-status.js";
import {
  resolveGatewayUrl,
  resolveScheme,
  validateMobilePairingUrl,
  type PairingConnectivityCommandRunner,
  type PairingConnectivityMode,
} from "./connectivity-routes.js";

export type PairingConnectivityAuth = "token" | "password" | "missing" | "unavailable" | "invalid";
type PairingConnectivityConfigState = "applied" | "pending" | "unknown";
type PairingSetupAccess = "full" | "limited" | "node";
type PairingConnectivityBlocker =
  | "gateway-auth-required"
  | "gateway-auth-unavailable"
  | "gateway-auth-invalid"
  | "route-unavailable"
  | "route-insecure"
  | "lan-unavailable"
  | "gateway-change-requires-applied-config"
  | "tailscale-unavailable"
  | "tailscale-login-required"
  | "tailscale-not-running"
  | "tailscale-starting"
  | "tailscale-status-error"
  | "tailscale-serve-required"
  | "tailscale-serve-conflict"
  | "tailscale-service-approval-required"
  | "tailscale-service-approval-unknown"
  | "public-url-required"
  | "public-url-invalid"
  | "public-url-insecure";
type PairingConnectivityChange = "expose-gateway-on-local-network";
/**
 * Owner-produced config write for a planned change. Both documents are JSON
 * merge patches handed to `config.patch` verbatim, so no client ever derives
 * config paths from a chosen route. `revert` carries the exact prior leaf; it
 * narrows the bind back, which would cut an operator that is not on the Gateway
 * host, so that operator gets manual recovery instead of an automatic inverse.
 */
type PairingConnectivityConfigWrite = {
  patch: string;
  revert: { execution: "automatic"; patch: string } | { execution: "manual" };
};
type PairingConnectivityAction = {
  kind: "retry";
  target: "gateway-host";
  execution: "manual";
  resumable: true;
};
type PairingConnectivityExposure = "same-host" | "local-network" | "tailnet" | "public-internet";
type PairingConnectivitySource =
  | "manual"
  | "remote"
  | "tailscale-serve"
  | "tailscale-funnel"
  | "lan"
  | "tailnet"
  | "custom";

type PairingConnectivityReadyRoute = {
  status: "ready";
  urls: string[];
  source: PairingConnectivitySource;
  exposure: PairingConnectivityExposure;
  access: PairingSetupAccess;
  accessDowngraded: boolean;
};

type PairingConnectivityInspection = {
  configHash?: string;
  configState: PairingConnectivityConfigState;
  auth: PairingConnectivityAuth;
  current:
    | PairingConnectivityReadyRoute
    | { status: "blocked"; blocker: PairingConnectivityBlocker };
  lan:
    | { status: "available"; url: string; requiresGatewayChange: boolean }
    | { status: "unavailable" };
  tailscale: TailscaleConnectivityInspection;
  publicUrl:
    | { status: "ready"; url: string }
    | { status: "not-configured" }
    | { status: "invalid" };
};

type PairingConnectivityPlan =
  | {
      status: "blocked";
      mode: PairingConnectivityMode;
      configHash?: string;
      configState: PairingConnectivityConfigState;
      auth: PairingConnectivityAuth;
      blocker: PairingConnectivityBlocker;
      changes: PairingConnectivityChange[];
      action?: PairingConnectivityAction;
    }
  | {
      status: "confirmation-required";
      mode: PairingConnectivityMode;
      configHash?: string;
      configState: PairingConnectivityConfigState;
      urls: string[];
      exposure: PairingConnectivityExposure;
      auth: "token" | "password";
      access: PairingSetupAccess;
      accessDowngraded: boolean;
      changes: PairingConnectivityChange[];
      configWrite?: PairingConnectivityConfigWrite;
      restartRequired: boolean;
      preservesCurrentRoute: boolean;
    };

export type PairingSetupConnectivityResolution =
  | {
      ok: true;
      urls: string[];
      authLabel: "token" | "password";
      urlSource: string;
      access: PairingSetupAccess;
      accessDowngraded: boolean;
      bootstrapProfile: DeviceBootstrapProfileInput;
    }
  | { ok: false; error: string };

export type ResolvePairingSetupConnectivityOptions = {
  env?: NodeJS.ProcessEnv;
  /**
   * Pins resolution to one planned route. Without it the historic precedence
   * (public URL, remote, Tailscale, then bind) applies, which would let a
   * configured route outrank the one a caller inspected and verified.
   */
  routeMode?: PairingConnectivityMode;
  publicUrl?: string;
  preferRemoteUrl?: boolean;
  forceSecure?: boolean;
  bootstrapProfile?: DeviceBootstrapProfileInput;
  runCommandWithTimeout?: PairingConnectivityCommandRunner;
  networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
};

type InternalPairingConnectivityOptions = ResolvePairingSetupConnectivityOptions & {
  activeAuth?: PairingConnectivityAuth;
};

function normalizeOperatorPublicUrl(
  raw: string | undefined,
):
  | { ok: true; url: string }
  | { ok: false; blocker: "public-url-required" | "public-url-invalid" | "public-url-insecure" } {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return { ok: false, blocker: "public-url-required" };
  }
  try {
    // `new URL` is the only authority here: it already normalizes the default
    // wss port away and reports credentials, path, query, and fragment, so a
    // second textual scan can only contradict it (a trailing root `/` is legal).
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "wss:") {
      return { ok: false, blocker: "public-url-insecure" };
    }
    if (
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return { ok: false, blocker: "public-url-invalid" };
    }
    return {
      ok: true,
      url: `wss://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
    };
  } catch {
    return { ok: false, blocker: "public-url-invalid" };
  }
}

function resolvePairingSetupAccess(profile: DeviceBootstrapProfileInput): PairingSetupAccess {
  if (deviceBootstrapProfilesEqual(profile, FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE)) {
    return "full";
  }
  return deviceBootstrapProfilesEqual(profile, NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE)
    ? "node"
    : "limited";
}

function resolvePairingAuth(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): PairingConnectivityAuth {
  if (hasAmbiguousGatewayAuthModeConfig(cfg)) {
    return "invalid";
  }
  const mode = cfg.gateway?.auth?.mode;
  const defaults = cfg.secrets?.defaults;
  // A value that still reads as a SecretRef was never materialized, so its
  // credential is unknown to this process. Counting it as configured auth would
  // let a caller mint a setup code for a Gateway that cannot honor it.
  const unresolvedToken = Boolean(
    resolveSecretInputRef({ value: cfg.gateway?.auth?.token, defaults }).ref,
  );
  const unresolvedPassword = Boolean(
    resolveSecretInputRef({ value: cfg.gateway?.auth?.password, defaults }).ref,
  );
  const envToken = Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN));
  const envPassword = Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD));
  // An unresolved `${ENV}` template is still a string, so the ref check has to
  // veto the literal read rather than merely sit beside it.
  const token = !unresolvedToken && Boolean(normalizeSecretInputString(cfg.gateway?.auth?.token));
  const password =
    !unresolvedPassword && Boolean(normalizeSecretInputString(cfg.gateway?.auth?.password));
  if (mode === "token") {
    return envToken || token ? "token" : unresolvedToken ? "unavailable" : "missing";
  }
  if (mode === "password") {
    return envPassword || password ? "password" : unresolvedPassword ? "unavailable" : "missing";
  }
  if (envToken) {
    return "token";
  }
  if (envPassword) {
    return "password";
  }
  if (token) {
    return "token";
  }
  if (password) {
    return "password";
  }
  return unresolvedToken || unresolvedPassword ? "unavailable" : "missing";
}

function exposureForRoute(url: string, source: string): PairingConnectivityExposure {
  if (source === "gateway.bind=lan") {
    return "local-network";
  }
  if (source === "gateway.bind=tailnet" || source === "gateway.tailscale.mode=serve") {
    return "tailnet";
  }
  if (source === "gateway.tailscale.mode=funnel" || source === "gateway.remote.url") {
    return "public-internet";
  }
  try {
    const parsed = new URL(url);
    const host = normalizePairingConnectivityHost(parsed.hostname);
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return "same-host";
    }
    return isPrivatePairingLanHost(host) ? "local-network" : "public-internet";
  } catch {
    return "public-internet";
  }
}

function semanticSource(source: string): PairingConnectivitySource {
  if (source === "gateway.remote.url") {
    return "remote";
  }
  if (source === "gateway.tailscale.mode=serve") {
    return "tailscale-serve";
  }
  if (source === "gateway.tailscale.mode=funnel") {
    return "tailscale-funnel";
  }
  if (source === "gateway.bind=lan") {
    return "lan";
  }
  if (source === "gateway.bind=tailnet") {
    return "tailnet";
  }
  if (source === "gateway.bind=custom") {
    return "custom";
  }
  return "manual";
}

async function resolvePairingSetupConnectivity(
  cfg: OpenClawConfig,
  options: InternalPairingConnectivityOptions,
): Promise<PairingSetupConnectivityResolution> {
  if (!options.activeAuth) {
    assertExplicitGatewayAuthModeWhenBothConfigured(cfg);
  }
  const env = options.env ?? process.env;
  const auth = options.activeAuth ?? resolvePairingAuth(cfg, env);
  if (auth === "invalid") {
    return { ok: false, error: "Gateway auth mode is ambiguous." };
  }
  if (auth === "unavailable") {
    return { ok: false, error: "Gateway auth is configured but unavailable." };
  }
  if (auth === "missing") {
    return { ok: false, error: "Gateway auth is not configured (no token or password)." };
  }
  const networkInterfaces = options.networkInterfaces ?? os.networkInterfaces;
  const route = await resolveGatewayUrl(cfg, { ...options, env, networkInterfaces });
  if (!route.url) {
    return { ok: false, error: route.error ?? "Gateway URL unavailable." };
  }
  const routeError = validateMobilePairingUrl(route.url, route.source);
  if (routeError) {
    return { ok: false, error: routeError };
  }
  const uniqueUrls = projectPairingConnectivityUrls(route.urls ?? [route.url]).filter(
    (url) => !validateMobilePairingUrl(url, route.source),
  );
  if (uniqueUrls.length === 0) {
    return { ok: false, error: "Gateway URL unavailable." };
  }
  const requestedProfile = options.bootstrapProfile ?? FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE;
  const accessDowngraded =
    deviceBootstrapProfilesEqual(requestedProfile, FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE) &&
    uniqueUrls.some((url) => !isFullAccessPairingConnectivityUrl(url));
  const bootstrapProfile = accessDowngraded ? PAIRING_SETUP_BOOTSTRAP_PROFILE : requestedProfile;
  return {
    ok: true,
    urls: uniqueUrls,
    authLabel: auth,
    urlSource: route.source ?? "unknown",
    access: resolvePairingSetupAccess(bootstrapProfile),
    accessDowngraded,
    bootstrapProfile,
  };
}

export async function resolvePairingSetupConnectivityFromConfig(
  cfg: OpenClawConfig,
  options: ResolvePairingSetupConnectivityOptions = {},
): Promise<PairingSetupConnectivityResolution> {
  return await resolvePairingSetupConnectivity(cfg, options);
}

export async function resolveActivePairingSetupConnectivity(
  cfg: OpenClawConfig,
  activeAuth: PairingConnectivityAuth,
  options: ResolvePairingSetupConnectivityOptions = {},
): Promise<PairingSetupConnectivityResolution> {
  return await resolvePairingSetupConnectivity(cfg, { ...options, activeAuth });
}

function currentBlocker(error: string | undefined): PairingConnectivityBlocker {
  return error?.includes("secure gateway URL") ? "route-insecure" : "route-unavailable";
}

export async function inspectPairingConnectivity(
  cfg: OpenClawConfig,
  options: {
    configHash?: string;
    configState?: PairingConnectivityConfigState;
    activeAuth?: PairingConnectivityAuth;
    configuredPublicUrl?: string;
    env?: NodeJS.ProcessEnv;
    runCommandWithTimeout?: PairingConnectivityCommandRunner;
    networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
  } = {},
): Promise<PairingConnectivityInspection> {
  const env = options.env ?? process.env;
  const networkInterfaces = options.networkInterfaces ?? os.networkInterfaces;
  const auth = options.activeAuth ?? resolvePairingAuth(cfg, env);
  const port = resolveGatewayPort(cfg, env);
  const [currentResolution, lanHost, tailscale] = await Promise.all([
    resolvePairingSetupConnectivity(cfg, {
      env,
      activeAuth: auth,
      publicUrl: options.configuredPublicUrl,
      runCommandWithTimeout: options.runCommandWithTimeout,
      networkInterfaces,
    }).catch(() => ({ ok: false as const, error: "invalid" })),
    resolveAdvertisedLanHost({
      networkInterfaces,
      runCommandWithTimeout: options.runCommandWithTimeout,
    }),
    inspectTailscaleConnectivityWithRunner(
      port,
      options.runCommandWithTimeout,
      cfg.gateway?.tailscale?.mode === "serve" ? cfg.gateway.tailscale.serviceName : undefined,
    ),
  ]);
  const configuredPublic = normalizeOptionalString(options.configuredPublicUrl);
  const strictPublic = configuredPublic ? normalizeOperatorPublicUrl(configuredPublic) : undefined;
  const current =
    currentResolution.ok && auth !== "missing" && auth !== "unavailable" && auth !== "invalid"
      ? {
          status: "ready" as const,
          urls: currentResolution.urls,
          source: semanticSource(currentResolution.urlSource),
          exposure: exposureForRoute(currentResolution.urls[0] ?? "", currentResolution.urlSource),
          access: currentResolution.access,
          accessDowngraded: currentResolution.accessDowngraded,
        }
      : {
          status: "blocked" as const,
          blocker:
            auth === "missing"
              ? ("gateway-auth-required" as const)
              : auth === "unavailable"
                ? ("gateway-auth-unavailable" as const)
                : auth === "invalid"
                  ? ("gateway-auth-invalid" as const)
                  : currentBlocker(currentResolution.ok ? undefined : currentResolution.error),
        };
  return {
    ...(options.configHash ? { configHash: options.configHash } : {}),
    configState: options.configState ?? "unknown",
    auth,
    current,
    lan: lanHost
      ? {
          status: "available",
          url: `${resolveScheme(cfg)}://${lanHost}:${port}`,
          requiresGatewayChange: cfg.gateway?.bind !== "lan",
        }
      : { status: "unavailable" },
    tailscale,
    publicUrl: !configuredPublic
      ? { status: "not-configured" }
      : strictPublic?.ok
        ? { status: "ready", url: strictPublic.url }
        : { status: "invalid" },
  };
}

function blockedPlan(
  inspect: PairingConnectivityInspection,
  mode: PairingConnectivityMode,
  blocker: PairingConnectivityBlocker,
  changes: PairingConnectivityChange[] = [],
  action?: PairingConnectivityAction,
): PairingConnectivityPlan {
  return {
    status: "blocked",
    mode,
    ...(inspect.configHash ? { configHash: inspect.configHash } : {}),
    configState: inspect.configState,
    auth: inspect.auth,
    blocker,
    changes,
    ...(action ? { action } : {}),
  };
}

const MANUAL_GATEWAY_HOST_RETRY: PairingConnectivityAction = {
  kind: "retry",
  target: "gateway-host",
  execution: "manual",
  resumable: true,
};

function blockedTailscalePlan(
  inspect: PairingConnectivityInspection,
  blocker: PairingConnectivityBlocker,
): PairingConnectivityPlan {
  return blockedPlan(inspect, "tailscale", blocker, [], MANUAL_GATEWAY_HOST_RETRY);
}

function buildLanConfigWrite(
  cfg: OpenClawConfig,
  operatorIsLocal: boolean,
): PairingConnectivityConfigWrite {
  // A null leaf deletes the key, restoring an unset bind exactly as it was.
  const previousBind = cfg.gateway?.bind ?? null;
  return {
    patch: JSON.stringify({ gateway: { bind: "lan" } }),
    revert: operatorIsLocal
      ? { execution: "automatic", patch: JSON.stringify({ gateway: { bind: previousBind } }) }
      : { execution: "manual" },
  };
}

export function planPairingConnectivity(
  cfg: OpenClawConfig,
  inspect: PairingConnectivityInspection,
  request: {
    mode: PairingConnectivityMode;
    publicUrl?: string;
    /** Absent means the operator is remote, which keeps route-losing steps manual. */
    operatorIsLocal?: boolean;
  },
): PairingConnectivityPlan {
  if (inspect.auth === "missing" || inspect.auth === "unavailable" || inspect.auth === "invalid") {
    return blockedPlan(
      inspect,
      request.mode,
      inspect.auth === "missing"
        ? "gateway-auth-required"
        : inspect.auth === "unavailable"
          ? "gateway-auth-unavailable"
          : "gateway-auth-invalid",
    );
  }
  let urls: string[];
  let exposure: PairingConnectivityExposure;
  let changes: PairingConnectivityChange[] = [];
  let configWrite: PairingConnectivityConfigWrite | undefined;
  let restartRequired = false;
  if (request.mode === "lan") {
    if (inspect.lan.status !== "available") {
      return blockedPlan(inspect, request.mode, "lan-unavailable");
    }
    urls = projectPairingConnectivityUrls([inspect.lan.url]);
    exposure = "local-network";
    if (inspect.lan.requiresGatewayChange) {
      // Unapplied config makes this unsafe for every operator: the patch and its
      // inverse are derived from the running config, so a restart would activate
      // the staged file instead, and the inverse would overwrite it.
      if (inspect.configState !== "applied") {
        return blockedPlan(
          inspect,
          request.mode,
          "gateway-change-requires-applied-config",
          ["expose-gateway-on-local-network"],
          MANUAL_GATEWAY_HOST_RETRY,
        );
      }
      changes = ["expose-gateway-on-local-network"];
      restartRequired = true;
      configWrite = buildLanConfigWrite(cfg, request.operatorIsLocal === true);
    }
  } else if (request.mode === "tailscale") {
    const tailscale = inspect.tailscale;
    if (tailscale.status === "unavailable") {
      return blockedTailscalePlan(inspect, "tailscale-unavailable");
    }
    if (tailscale.status === "login-required") {
      return blockedTailscalePlan(inspect, "tailscale-login-required");
    }
    if (tailscale.status === "stopped") {
      return blockedTailscalePlan(inspect, "tailscale-not-running");
    }
    if (tailscale.status === "starting") {
      return blockedTailscalePlan(inspect, "tailscale-starting");
    }
    if (tailscale.status === "error") {
      return blockedTailscalePlan(inspect, "tailscale-status-error");
    }
    if (tailscale.serve.status === "unreadable") {
      return blockedTailscalePlan(inspect, "tailscale-status-error");
    }
    if (tailscale.serve.status === "conflicting-root") {
      return blockedTailscalePlan(inspect, "tailscale-serve-conflict");
    }
    const tailscaleUrls = selectTailscaleGatewayUrls(tailscale, "serve");
    if (tailscaleUrls.length === 0) {
      return blockedTailscalePlan(inspect, "tailscale-serve-required");
    }
    if (tailscale.serviceApproval === "required") {
      return blockedTailscalePlan(inspect, "tailscale-service-approval-required");
    }
    if (tailscale.serviceApproval === "unknown") {
      return blockedTailscalePlan(inspect, "tailscale-service-approval-unknown");
    }
    urls = projectPairingConnectivityUrls(tailscaleUrls);
    exposure = "tailnet";
  } else {
    const publicUrl = normalizeOperatorPublicUrl(request.publicUrl);
    if (!publicUrl.ok) {
      return blockedPlan(inspect, request.mode, publicUrl.blocker);
    }
    urls = projectPairingConnectivityUrls([publicUrl.url]);
    exposure = "public-internet";
  }
  const accessDowngraded = urls.some((url) => !isFullAccessPairingConnectivityUrl(url));
  return {
    status: "confirmation-required",
    mode: request.mode,
    ...(inspect.configHash ? { configHash: inspect.configHash } : {}),
    configState: inspect.configState,
    urls,
    exposure,
    auth: inspect.auth,
    access: accessDowngraded ? "limited" : "full",
    accessDowngraded,
    changes,
    ...(configWrite ? { configWrite } : {}),
    restartRequired,
    preservesCurrentRoute: !restartRequired,
  };
}
