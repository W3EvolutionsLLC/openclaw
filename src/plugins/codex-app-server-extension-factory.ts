import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import type { PluginCodexAppServerExtensionFactoryRegistration } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";

export const CODEX_APP_SERVER_EXTENSION_RUNTIME_ID = "codex-app-server";

function copyCodexAppServerExtensionFactoryEntries(
  entries: unknown,
): PluginCodexAppServerExtensionFactoryRegistration[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  let length = 0;
  try {
    length = entries.length;
  } catch {
    return [];
  }
  const copied: PluginCodexAppServerExtensionFactoryRegistration[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      copied.push(entries[index]);
    } catch {
      // Skip unreadable extension factory entries; later bundled factories can still run.
    }
  }
  return copied;
}

function readCodexAppServerExtensionFactory(
  entry: PluginCodexAppServerExtensionFactoryRegistration,
): CodexAppServerExtensionFactory | null {
  try {
    return typeof entry.factory === "function" ? entry.factory : null;
  } catch {
    return null;
  }
}

export function listCodexAppServerExtensionFactories() {
  const entries = copyCodexAppServerExtensionFactoryEntries(
    getActivePluginRegistry()?.codexAppServerExtensionFactories,
  );
  return entries.flatMap((entry) => {
    const factory = readCodexAppServerExtensionFactory(entry);
    return factory ? [factory] : [];
  });
}
