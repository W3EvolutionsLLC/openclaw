import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPlainObject } from "../utils.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
  PluginHookToolInputKind,
  PluginHookToolKind,
} from "./hook-types.js";
import { getPluginSessionExtensionStateSync } from "./host-hook-state.js";
import type { PluginJsonValue } from "./host-hooks.js";
import type { PluginTrustedToolPolicyRegistryRegistration } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";

export function hasTrustedToolPolicies(): boolean {
  return (getActivePluginRegistry()?.trustedToolPolicies?.length ?? 0) > 0;
}

type TrustedPolicyRegistration = PluginTrustedToolPolicyRegistryRegistration;

type TrustedPolicyDecisionField =
  | "allow"
  | "block"
  | "blockReason"
  | "params"
  | "reason"
  | "requireApproval";

type TrustedPolicyDecisionFieldRead =
  | {
      ok: true;
      present: boolean;
      value: unknown;
    }
  | {
      ok: false;
    };

type TrustedPolicyPlainObjectRead =
  | {
      ok: true;
      isPlain: boolean;
      value?: Record<string, unknown>;
    }
  | {
      ok: false;
    };

function readTrustedPolicyId(registration: TrustedPolicyRegistration): string {
  try {
    const id = registration.policy.id;
    return typeof id === "string" && id.trim() ? id.trim() : registration.pluginId;
  } catch {
    return registration.pluginId;
  }
}

function trustedPolicyDefaultBlockReason(registration: TrustedPolicyRegistration): string {
  return `blocked by ${readTrustedPolicyId(registration)}`;
}

function trustedPolicyFailureResult(
  registration: TrustedPolicyRegistration,
  detail: string,
): PluginHookBeforeToolCallResult {
  return {
    block: true,
    blockReason: `${trustedPolicyDefaultBlockReason(registration)}: ${detail}`,
  };
}

function readTrustedPolicyDecisionField(
  decision: unknown,
  field: TrustedPolicyDecisionField,
): TrustedPolicyDecisionFieldRead {
  if ((typeof decision !== "object" && typeof decision !== "function") || decision === null) {
    return { ok: true, present: false, value: undefined };
  }
  try {
    if (!(field in decision)) {
      return { ok: true, present: false, value: undefined };
    }
    return {
      ok: true,
      present: true,
      value: (decision as Record<string, unknown>)[field],
    };
  } catch {
    return { ok: false };
  }
}

function readTrustedPolicyDecisionString(
  decision: unknown,
  field: "blockReason" | "reason",
): string | undefined {
  const read = readTrustedPolicyDecisionField(decision, field);
  return read.ok && read.present && typeof read.value === "string" && read.value.trim()
    ? read.value
    : undefined;
}

function readTrustedPolicyPlainObject(value: unknown): TrustedPolicyPlainObjectRead {
  try {
    return isPlainObject(value) ? { ok: true, isPlain: true, value } : { ok: true, isPlain: false };
  } catch {
    return { ok: false };
  }
}

function normalizeDerivedEventFields(
  value: Pick<PluginHookBeforeToolCallEvent, "derivedPaths"> | undefined,
): Pick<PluginHookBeforeToolCallEvent, "derivedPaths"> {
  return Array.isArray(value?.derivedPaths)
    ? { derivedPaths: Object.freeze([...value.derivedPaths]) }
    : {};
}

function normalizeToolIdentity(
  value:
    | Pick<PluginHookBeforeToolCallEvent, "toolKind" | "toolInputKind">
    | Pick<PluginHookToolContext, "toolKind" | "toolInputKind">
    | undefined,
): { toolKind?: PluginHookToolKind; toolInputKind?: PluginHookToolInputKind } {
  return {
    ...(value?.toolKind && { toolKind: value.toolKind }),
    ...(value?.toolInputKind && { toolInputKind: value.toolInputKind }),
  };
}

export async function runTrustedToolPolicies(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
  options?: {
    config?: OpenClawConfig;
    deriveEvent?: (
      params: Record<string, unknown>,
    ) => Pick<PluginHookBeforeToolCallEvent, "derivedPaths">;
    normalizeEvent?: (
      event: PluginHookBeforeToolCallEvent,
      ctx: PluginHookToolContext,
    ) =>
      | {
          params?: Record<string, unknown>;
          event?: Pick<PluginHookBeforeToolCallEvent, "toolKind" | "toolInputKind">;
          ctx?: Pick<PluginHookToolContext, "toolKind" | "toolInputKind">;
        }
      | undefined;
  },
): Promise<PluginHookBeforeToolCallResult | undefined> {
  const policies = getActivePluginRegistry()?.trustedToolPolicies ?? [];
  let adjustedParams = event.params;
  let hasAdjustedParams = false;
  let approval: PluginHookBeforeToolCallResult["requireApproval"];
  const sessionExtensionStateCache = new Map<string, Record<string, PluginJsonValue> | undefined>();
  let resolvedSessionConfig: OpenClawConfig | undefined = options?.config;
  let didResolveSessionConfig = Boolean(options?.config);
  const resolveSessionConfig = (): OpenClawConfig | undefined => {
    if (!didResolveSessionConfig) {
      didResolveSessionConfig = true;
      try {
        resolvedSessionConfig = getRuntimeConfig();
      } catch {
        resolvedSessionConfig = undefined;
      }
    }
    return resolvedSessionConfig;
  };
  const { derivedPaths, toolKind, toolInputKind, ...eventWithoutDerivedPaths } = event;
  const { toolKind: ctxToolKind, toolInputKind: ctxToolInputKind, ...ctxWithoutToolIdentity } = ctx;
  let currentDerivedEvent = normalizeDerivedEventFields({ derivedPaths });
  let currentEventToolIdentity = normalizeToolIdentity({ toolKind, toolInputKind });
  let currentContextToolIdentity = normalizeToolIdentity({
    toolKind: ctxToolKind,
    toolInputKind: ctxToolInputKind,
  });
  const buildEvent = (): PluginHookBeforeToolCallEvent => {
    return {
      ...eventWithoutDerivedPaths,
      params: adjustedParams,
      ...currentEventToolIdentity,
      ...currentDerivedEvent,
    };
  };
  for (const registration of policies) {
    const policyCtx: PluginHookToolContext = {
      ...ctxWithoutToolIdentity,
      ...currentContextToolIdentity,
      // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Plugin callers type JSON reads by namespace.
      getSessionExtension: <T extends PluginJsonValue = PluginJsonValue>(namespace: string) => {
        const normalizedNamespace = namespace.trim();
        const cacheKey = registration.pluginId;
        if (!sessionExtensionStateCache.has(cacheKey)) {
          const config = ctx.sessionKey ? resolveSessionConfig() : undefined;
          sessionExtensionStateCache.set(
            cacheKey,
            config
              ? getPluginSessionExtensionStateSync({
                  cfg: config,
                  pluginId: registration.pluginId,
                  sessionKey: ctx.sessionKey,
                })
              : undefined,
          );
        }
        const pluginState = sessionExtensionStateCache.get(cacheKey);
        if (!normalizedNamespace || !pluginState) {
          return undefined;
        }
        return pluginState[normalizedNamespace] as T | undefined;
      },
    };
    let decision: unknown;
    try {
      decision = await registration.policy.evaluate(buildEvent(), policyCtx);
    } catch {
      return trustedPolicyFailureResult(registration, "policy evaluation failed");
    }
    if (!decision) {
      continue;
    }
    const allow = readTrustedPolicyDecisionField(decision, "allow");
    if (!allow.ok) {
      return trustedPolicyFailureResult(registration, "policy decision has unreadable allow");
    }
    if (allow.present && allow.value === false) {
      return {
        block: true,
        blockReason:
          readTrustedPolicyDecisionString(decision, "reason") ??
          trustedPolicyDefaultBlockReason(registration),
      };
    }
    // `block: true` is terminal; normalize a missing blockReason to a deterministic
    // reason so downstream diagnostics match the `{ allow: false }` path above.
    const block = readTrustedPolicyDecisionField(decision, "block");
    if (!block.ok) {
      return trustedPolicyFailureResult(registration, "policy decision has unreadable block");
    }
    if (block.present && block.value === true) {
      return {
        block: true,
        blockReason:
          readTrustedPolicyDecisionString(decision, "blockReason") ??
          trustedPolicyDefaultBlockReason(registration),
      };
    }
    // `block: false` is a no-op (matches the regular `before_tool_call` hook
    // pipeline) — it does NOT short-circuit the policy chain. Params and
    // approvals are remembered so later trusted policies can still inspect or
    // block the final call.
    const params = readTrustedPolicyDecisionField(decision, "params");
    if (!params.ok) {
      return trustedPolicyFailureResult(registration, "policy decision has unreadable params");
    }
    if (params.present) {
      const plainParams = readTrustedPolicyPlainObject(params.value);
      if (!plainParams.ok) {
        return trustedPolicyFailureResult(registration, "policy decision has unreadable params");
      }
      if (plainParams.isPlain && plainParams.value) {
        const normalized = options?.normalizeEvent?.(
          {
            ...eventWithoutDerivedPaths,
            params: plainParams.value,
            ...currentEventToolIdentity,
            ...currentDerivedEvent,
          },
          policyCtx,
        );
        adjustedParams = normalized?.params ?? plainParams.value;
        if (normalized?.event) {
          currentEventToolIdentity = normalizeToolIdentity(normalized.event);
        }
        if (normalized?.ctx) {
          currentContextToolIdentity = normalizeToolIdentity(normalized.ctx);
        } else if (normalized?.event) {
          currentContextToolIdentity = normalizeToolIdentity(normalized.event);
        }
        hasAdjustedParams = true;
        currentDerivedEvent = normalizeDerivedEventFields(options?.deriveEvent?.(adjustedParams));
      }
    }
    const requireApproval = readTrustedPolicyDecisionField(decision, "requireApproval");
    if (!requireApproval.ok) {
      return trustedPolicyFailureResult(
        registration,
        "policy decision has unreadable requireApproval",
      );
    }
    if (requireApproval.present && requireApproval.value && !approval) {
      approval = requireApproval.value as PluginHookBeforeToolCallResult["requireApproval"];
    }
  }
  if (!hasAdjustedParams && !approval) {
    return undefined;
  }
  return {
    ...(hasAdjustedParams ? { params: adjustedParams } : {}),
    ...(approval ? { requireApproval: approval } : {}),
  };
}
