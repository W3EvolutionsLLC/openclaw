import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getLoadedChannelPluginById } from "./registry-loaded.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

export function getLoadedChannelPluginForRead(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return getLoadedChannelPluginById(resolvedId) as ChannelPlugin | undefined;
}
