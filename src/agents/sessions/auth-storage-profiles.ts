/** Internal auth-profile sidecar for catalog request authentication. */
import type {
  ApiKeyCredential,
  AuthProfileStore,
  TokenCredential,
} from "../auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import type { AuthCredential } from "./auth-storage.js";
import { resolveConfigValue } from "./resolve-config-value.js";

type MaterializedProfile =
  | (ApiKeyCredential & { key: string })
  | (TokenCredential & { token: string });
type ProfileData = Record<string, MaterializedProfile>;
type AuthStorageAccess = {
  getCredential: (provider: string) => AuthCredential | undefined;
  getRuntimeOverride: (provider: string) => string | undefined;
};

const profileDataByStorage = new WeakMap<object, ProfileData>();
const accessByStorage = new WeakMap<object, AuthStorageAccess>();
const credentialFreeStorage = new WeakSet<object>();
const liveDefaultStorage = new WeakSet<object>();

export function registerAuthStorageAccess(storage: object, access: AuthStorageAccess): void {
  accessByStorage.set(storage, access);
}

export function attachAuthStorageProfiles(
  storage: object,
  store: AuthProfileStore,
  options?: { liveDefault?: boolean },
): void {
  const profiles = Object.fromEntries(
    Object.entries(structuredClone(store.profiles)).filter(
      ([profileId, profile]) =>
        ((profile.type === "api_key" && Boolean(profile.key)) ||
          (profile.type === "token" && Boolean(profile.token))) &&
        (!options?.liveDefault || profileId !== `${profile.provider}:default`),
    ),
  ) as ProfileData;
  profileDataByStorage.set(storage, profiles);
  if (options?.liveDefault) {
    liveDefaultStorage.add(storage);
  }
}

export function copyAuthStorageProfiles(source: object, target: object): void {
  profileDataByStorage.set(target, structuredClone(profileDataByStorage.get(source) ?? {}));
}

function resolveProfile(
  storage: object,
  provider: string,
  profileId: string,
): ProfileData[string] | undefined {
  if (credentialFreeStorage.has(storage)) {
    return undefined;
  }
  const liveDefault =
    liveDefaultStorage.has(storage) && profileId === `${provider}:default`
      ? accessByStorage.get(storage)?.getCredential(provider)
      : undefined;
  const profile =
    liveDefault?.type === "api_key" || liveDefault?.type === "token"
      ? ({ ...liveDefault, provider } as MaterializedProfile)
      : profileDataByStorage.get(storage)?.[profileId];
  return profile &&
    resolveProviderIdForAuth(profile.provider) === resolveProviderIdForAuth(provider)
    ? profile
    : undefined;
}

export function hasAuthStorageProfile(
  storage: object,
  provider: string,
  profileId: string,
  options?: { includeRuntimeOverride?: boolean },
): boolean {
  return Boolean(
    (options?.includeRuntimeOverride !== false &&
      accessByStorage.get(storage)?.getRuntimeOverride(provider)) ||
    resolveProfile(storage, provider, profileId),
  );
}

export function resolveAuthStorageProfileApiKey(
  storage: object,
  provider: string,
  profileId: string,
): string | undefined {
  const runtimeOverride = accessByStorage.get(storage)?.getRuntimeOverride(provider);
  if (runtimeOverride) {
    return runtimeOverride;
  }
  if (credentialFreeStorage.has(storage)) {
    return undefined;
  }
  const profile = resolveProfile(storage, provider, profileId);
  return profile?.type === "api_key"
    ? resolveConfigValue(profile.key)
    : profile?.type === "token" && (profile.expires === undefined || Date.now() < profile.expires)
      ? resolveConfigValue(profile.token)
      : undefined;
}

export function markAuthStorageCredentialFree<T extends object>(storage: T): T {
  credentialFreeStorage.add(storage);
  return storage;
}

export function isAuthStorageCredentialFree(storage: object): boolean {
  return credentialFreeStorage.has(storage);
}
