/** Internal auth-profile sidecar for catalog request authentication. */
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import type { ApiKeyCredential, AuthCredential, TokenCredential } from "./auth-storage.js";
import { resolveConfigValue } from "./resolve-config-value.js";

type ProfileData = Record<
  string,
  { provider: string; credential: ApiKeyCredential | TokenCredential }
>;
type AuthStorageAccess = {
  getRuntimeOverride: (provider: string) => string | undefined;
};

const profileDataByStorage = new WeakMap<object, ProfileData>();
const accessByStorage = new WeakMap<object, AuthStorageAccess>();
const credentialFreeStorage = new WeakSet<object>();
const defaultProjectionStorage = new WeakSet<object>();

export function registerAuthStorageAccess(storage: object, access: AuthStorageAccess): void {
  accessByStorage.set(storage, access);
}

export function attachAuthStorageProfiles(storage: object, store: AuthProfileStore): void {
  const profiles: ProfileData = {};
  for (const [profileId, profile] of Object.entries(store.profiles)) {
    if (profile.type === "api_key" && profile.key) {
      profiles[profileId] = {
        provider: profile.provider,
        credential: { type: "api_key", key: profile.key },
      };
    } else if (profile.type === "token" && profile.token) {
      profiles[profileId] = {
        provider: profile.provider,
        credential: {
          type: "token",
          token: profile.token,
          ...(profile.expires !== undefined ? { expires: profile.expires } : {}),
        },
      };
    }
  }
  profileDataByStorage.set(storage, profiles);
}

export function copyAuthStorageProfiles(source: object, target: object): void {
  profileDataByStorage.set(target, structuredClone(profileDataByStorage.get(source) ?? {}));
}

export function markAuthStorageDefaultProjection(storage: object): void {
  defaultProjectionStorage.add(storage);
}

export function updateAuthStorageDefaultProfile(
  storage: object,
  provider: string,
  credential: AuthCredential | undefined,
): void {
  const profiles = profileDataByStorage.get(storage) ?? {};
  const profileId = `${provider}:default`;
  if (credential?.type === "api_key" || credential?.type === "token") {
    profiles[profileId] = { provider, credential };
  } else {
    delete profiles[profileId];
  }
  profileDataByStorage.set(storage, profiles);
}

export function syncAuthStorageReloadedProfiles(
  storage: object,
  data: Record<string, AuthCredential>,
): void {
  if (!defaultProjectionStorage.has(storage)) {
    return;
  }
  const profiles = profileDataByStorage.get(storage) ?? {};
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (profileId === `${profile.provider}:default`) {
      delete profiles[profileId];
    }
  }
  profileDataByStorage.set(storage, profiles);
  for (const [provider, credential] of Object.entries(data)) {
    updateAuthStorageDefaultProfile(storage, provider, credential);
  }
}

function resolveProfile(
  storage: object,
  provider: string,
  profileId: string,
): ProfileData[string] | undefined {
  if (credentialFreeStorage.has(storage)) {
    return undefined;
  }
  const profile = profileDataByStorage.get(storage)?.[profileId];
  return profile &&
    resolveProviderIdForAuth(profile.provider) === resolveProviderIdForAuth(provider) &&
    (profile.credential.type === "api_key" || profile.credential.type === "token")
    ? profile
    : undefined;
}

export function hasAuthStorageProfile(
  storage: object,
  provider: string,
  profileId: string,
): boolean {
  return Boolean(
    !credentialFreeStorage.has(storage) &&
    (accessByStorage.get(storage)?.getRuntimeOverride(provider) ||
      resolveProfile(storage, provider, profileId)),
  );
}

export function resolveAuthStorageProfileApiKey(
  storage: object,
  provider: string,
  profileId: string,
): string | undefined {
  if (credentialFreeStorage.has(storage)) {
    return undefined;
  }
  const runtimeOverride = accessByStorage.get(storage)?.getRuntimeOverride(provider);
  if (runtimeOverride) {
    return runtimeOverride;
  }
  const credential = resolveProfile(storage, provider, profileId)?.credential;
  return credential?.type === "api_key"
    ? resolveConfigValue(credential.key)
    : credential?.type === "token" &&
        (credential.expires === undefined || Date.now() < credential.expires)
      ? resolveConfigValue(credential.token)
      : undefined;
}

export function markAuthStorageCredentialFree<T extends object>(storage: T): T {
  credentialFreeStorage.add(storage);
  profileDataByStorage.set(storage, {});
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
