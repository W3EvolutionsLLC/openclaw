/** Internal auth-profile sidecar for catalog request authentication. */
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import type { ApiKeyCredential, AuthStorageData, TokenCredential } from "./auth-storage.js";
import { resolveConfigValue } from "./resolve-config-value.js";

type AuthProfileStorageData = Record<
  string,
  { provider: string; credential: ApiKeyCredential | TokenCredential }
>;

const profileDataByStorage = new WeakMap<object, AuthProfileStorageData>();
const runtimeOverridesByStorage = new WeakMap<object, Map<string, string>>();
const credentialFreeStorage = new WeakSet<object>();

function projectAuthProfileStorageData(store: AuthProfileStore): AuthProfileStorageData {
  return Object.fromEntries(
    Object.entries(store.profiles).flatMap(([profileId, profile]) => {
      const credential: ApiKeyCredential | TokenCredential | undefined =
        profile.type === "api_key" && profile.key
          ? { type: "api_key", key: profile.key }
          : profile.type === "token" && profile.token
            ? {
                type: "token",
                token: profile.token,
                ...(profile.expires !== undefined ? { expires: profile.expires } : {}),
              }
            : undefined;
      return credential ? [[profileId, { provider: profile.provider, credential }]] : [];
    }),
  );
}

export function attachAuthStorageProfiles(storage: object, store: AuthProfileStore): void {
  profileDataByStorage.set(storage, projectAuthProfileStorageData(store));
}

export function copyAuthStorageProfiles(source: object, target: object): void {
  profileDataByStorage.set(target, structuredClone(profileDataByStorage.get(source) ?? {}));
}

export function syncAuthStorageDefaultProfiles(storage: object, data: AuthStorageData): void {
  const profiles = profileDataByStorage.get(storage) ?? {};
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (profileId === `${profile.provider}:default`) {
      delete profiles[profileId];
    }
  }
  for (const [provider, credential] of Object.entries(data)) {
    if (credential.type === "api_key" || credential.type === "token") {
      profiles[`${provider}:default`] = { provider, credential };
    }
  }
  profileDataByStorage.set(storage, profiles);
}

export function setAuthStorageRuntimeOverride(
  storage: object,
  provider: string,
  apiKey?: string,
): void {
  const overrides = runtimeOverridesByStorage.get(storage) ?? new Map<string, string>();
  if (apiKey === undefined) {
    overrides.delete(provider);
  } else {
    overrides.set(provider, apiKey);
  }
  runtimeOverridesByStorage.set(storage, overrides);
}

function getAuthStorageRuntimeOverride(storage: object, provider: string): string | undefined {
  return runtimeOverridesByStorage.get(storage)?.get(provider);
}

export function hasAuthStorageProfile(
  storage: object,
  provider: string,
  profileId: string,
): boolean {
  if (getAuthStorageRuntimeOverride(storage, provider)) {
    return true;
  }
  const profile = profileDataByStorage.get(storage)?.[profileId];
  return Boolean(
    profile && resolveProviderIdForAuth(profile.provider) === resolveProviderIdForAuth(provider),
  );
}

export function resolveAuthStorageProfileApiKey(
  storage: object,
  provider: string,
  profileId: string,
): string | undefined {
  const runtimeOverride = getAuthStorageRuntimeOverride(storage, provider);
  if (runtimeOverride) {
    return runtimeOverride;
  }
  const profile = profileDataByStorage.get(storage)?.[profileId];
  if (
    !profile ||
    resolveProviderIdForAuth(profile.provider) !== resolveProviderIdForAuth(provider)
  ) {
    return undefined;
  }
  const credential = profile.credential;
  return credential.type === "api_key"
    ? resolveConfigValue(credential.key)
    : credential.expires === undefined || Date.now() < credential.expires
      ? resolveConfigValue(credential.token)
      : undefined;
}

export function markAuthStorageCredentialFree<T extends object>(storage: T): T {
  credentialFreeStorage.add(storage);
  profileDataByStorage.set(storage, {});
  runtimeOverridesByStorage.delete(storage);
  return storage;
}

export function isAuthStorageCredentialFree(storage: object): boolean {
  return credentialFreeStorage.has(storage);
}

/** Retains profile state whose credential row is intentionally absent. */
export function collectStateOnlyAuthProfileIds(store: AuthProfileStore): string[] {
  const referenced = new Set([
    ...Object.values(store.order ?? {}).flat(),
    ...Object.values(store.lastGood ?? {}),
    ...Object.keys(store.usageStats ?? {}),
  ]);
  return [...referenced].filter((profileId) => !store.profiles[profileId]);
}
