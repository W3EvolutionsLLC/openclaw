import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import * as providerAuthChoices from "../plugins/provider-auth-choices.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import * as providerInstallCatalog from "../plugins/provider-install-catalog.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { FlowContribution, FlowOption } from "./types.js";
import { sortFlowContributionsByLabel } from "./types.js";

type ProviderFlowScope = "text-inference" | "image-generation" | "music-generation";

const DEFAULT_PROVIDER_FLOW_SCOPE: ProviderFlowScope = "text-inference";

type ProviderSetupFlowOption = FlowOption & {
  onboardingScopes?: ProviderFlowScope[];
  onboardingFeatured?: boolean;
};

type ProviderSetupFlowContribution = FlowContribution & {
  kind: "provider";
  surface: "setup";
  providerId: string;
  pluginId?: string;
  option: ProviderSetupFlowOption;
  onboardingScopes?: ProviderFlowScope[];
  source: "manifest" | "install-catalog";
};

type ProviderAuthChoiceFlowFields = ProviderAuthChoiceMetadata;
type ProviderInstallCatalogFlowEntry = ProviderAuthChoiceFlowFields & {
  label: string;
  origin: PluginOrigin;
};

function readRecordValue(record: unknown, field: string): unknown {
  if (record === null || typeof record !== "object") {
    return undefined;
  }
  try {
    return (record as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function readStringField(record: unknown, field: string): string | undefined {
  return normalizeOptionalString(readRecordValue(record, field));
}

function readNumberField(record: unknown, field: string): number | undefined {
  const value = readRecordValue(record, field);
  return typeof value === "number" ? value : undefined;
}

function readProviderFlowScopeList(record: unknown): ProviderFlowScope[] | undefined {
  const value = readRecordValue(record, "onboardingScopes");
  if (!Array.isArray(value)) {
    return undefined;
  }
  const scopes: ProviderFlowScope[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let scope: unknown;
    try {
      scope = value[index];
    } catch {
      continue;
    }
    if (
      scope === "text-inference" ||
      scope === "image-generation" ||
      scope === "music-generation"
    ) {
      scopes.push(scope);
    }
  }
  return scopes.length > 0 ? scopes : undefined;
}

function readAssistantVisibility(
  record: unknown,
): ProviderSetupFlowOption["assistantVisibility"] | undefined {
  const value = readStringField(record, "assistantVisibility");
  return value === "visible" || value === "manual-only" ? value : undefined;
}

function readPluginOrigin(record: unknown): PluginOrigin | undefined {
  const value = readStringField(record, "origin");
  return value === "bundled" || value === "global" || value === "workspace" || value === "config"
    ? value
    : undefined;
}

function copyProviderAuthChoiceFields(choice: unknown): ProviderAuthChoiceFlowFields | undefined {
  const pluginId = readStringField(choice, "pluginId");
  const providerId = readStringField(choice, "providerId");
  const methodId = readStringField(choice, "methodId");
  const choiceId = readStringField(choice, "choiceId");
  const choiceLabel = readStringField(choice, "choiceLabel");
  if (!pluginId || !providerId || !methodId || !choiceId || !choiceLabel) {
    return undefined;
  }
  const choiceHint = readStringField(choice, "choiceHint");
  const assistantPriority = readNumberField(choice, "assistantPriority");
  const assistantVisibility = readAssistantVisibility(choice);
  const groupId = readStringField(choice, "groupId");
  const groupLabel = readStringField(choice, "groupLabel");
  const groupHint = readStringField(choice, "groupHint");
  const onboardingScopes = readProviderFlowScopeList(choice);
  return {
    pluginId,
    providerId,
    methodId,
    choiceId,
    choiceLabel,
    ...(choiceHint ? { choiceHint } : {}),
    ...(assistantPriority !== undefined ? { assistantPriority } : {}),
    ...(assistantVisibility ? { assistantVisibility } : {}),
    ...(groupId ? { groupId } : {}),
    ...(groupLabel ? { groupLabel } : {}),
    ...(groupHint ? { groupHint } : {}),
    ...(readRecordValue(choice, "onboardingFeatured") === true ? { onboardingFeatured: true } : {}),
    ...(onboardingScopes ? { onboardingScopes } : {}),
  };
}

function copyProviderInstallCatalogFlowEntry(
  entry: unknown,
): ProviderInstallCatalogFlowEntry | undefined {
  const choice = copyProviderAuthChoiceFields(entry);
  const label = readStringField(entry, "label");
  const origin = readPluginOrigin(entry);
  if (!choice || !label || !origin) {
    return undefined;
  }
  return { ...choice, label, origin };
}

function includesProviderFlowScope(
  scopes: readonly ProviderFlowScope[] | undefined,
  scope: ProviderFlowScope,
): boolean {
  return scopes ? scopes.includes(scope) : scope === DEFAULT_PROVIDER_FLOW_SCOPE;
}

function resolveInstallCatalogProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  const normalizedPluginsConfig = normalizePluginsConfig(params?.config?.plugins);
  return providerInstallCatalog
    .resolveProviderInstallCatalogEntries({
      ...params,
      includeUntrustedWorkspacePlugins: false,
    })
    .flatMap((rawEntry) => {
      const entry = copyProviderInstallCatalogFlowEntry(rawEntry);
      if (
        !entry ||
        !includesProviderFlowScope(entry.onboardingScopes, scope) ||
        !resolveEffectiveEnableState({
          id: entry.pluginId,
          origin: entry.origin,
          config: normalizedPluginsConfig,
          rootConfig: params?.config,
          enabledByDefault: true,
        }).enabled
      ) {
        return [];
      }
      const groupId = entry.groupId ?? entry.providerId;
      const groupLabel = entry.groupLabel ?? entry.label;
      return [
        Object.assign(
          {
            id: `provider:setup:${entry.choiceId}`,
            kind: `provider` as const,
            surface: `setup` as const,
            providerId: entry.providerId,
            pluginId: entry.pluginId,
            option: {
              value: entry.choiceId,
              label: entry.choiceLabel,
              ...(entry.choiceHint ? { hint: entry.choiceHint } : {}),
              ...(entry.assistantPriority !== undefined
                ? { assistantPriority: entry.assistantPriority }
                : {}),
              ...(entry.assistantVisibility
                ? { assistantVisibility: entry.assistantVisibility }
                : {}),
              group: {
                id: groupId,
                label: groupLabel,
                ...(entry.groupHint ? { hint: entry.groupHint } : {}),
              },
            },
          },
          entry.onboardingScopes ? { onboardingScopes: [...entry.onboardingScopes] } : {},
          { source: `install-catalog` as const },
        ),
      ];
    });
}

function resolveManifestProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  return providerAuthChoices
    .resolveManifestProviderAuthChoices({
      ...params,
      includeUntrustedWorkspacePlugins: false,
    })
    .flatMap((rawChoice) => {
      const choice = copyProviderAuthChoiceFields(rawChoice);
      if (!choice || !includesProviderFlowScope(choice.onboardingScopes, scope)) {
        return [];
      }
      const groupId = choice.groupId ?? choice.providerId;
      const groupLabel = choice.groupLabel ?? choice.choiceLabel;
      return [
        Object.assign(
          {
            id: `provider:setup:${choice.choiceId}`,
            kind: `provider` as const,
            surface: `setup` as const,
            providerId: choice.providerId,
            pluginId: choice.pluginId,
            option: {
              value: choice.choiceId,
              label: choice.choiceLabel,
              ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
              ...(choice.assistantPriority !== undefined
                ? { assistantPriority: choice.assistantPriority }
                : {}),
              ...(choice.assistantVisibility
                ? { assistantVisibility: choice.assistantVisibility }
                : {}),
              ...(choice.onboardingFeatured ? { onboardingFeatured: true } : {}),
              group: {
                id: groupId,
                label: groupLabel,
                ...(choice.groupHint ? { hint: choice.groupHint } : {}),
              },
            },
          },
          choice.onboardingScopes ? { onboardingScopes: [...choice.onboardingScopes] } : {},
          { source: `manifest` as const },
        ),
      ];
    });
}

export function resolveProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  const manifestContributions = resolveManifestProviderSetupFlowContributions({
    ...params,
    scope,
  });
  const seenOptionValues = new Set(
    manifestContributions.map((contribution) => contribution.option.value),
  );
  const installCatalogContributions = resolveInstallCatalogProviderSetupFlowContributions({
    ...params,
    scope,
  }).filter((contribution) => !seenOptionValues.has(contribution.option.value));
  return sortFlowContributionsByLabel([...manifestContributions, ...installCatalogContributions]);
}
