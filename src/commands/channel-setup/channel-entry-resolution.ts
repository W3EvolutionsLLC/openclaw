// Canonical channel setup target resolution shared by CLI and interactive setup flows.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

type ChannelEntry = {
  id: string;
  meta: { aliases?: readonly string[] };
};

/** Resolve an entry by id or alias without allowing an alias to shadow a canonical id. */
export function resolveChannelEntry<T extends ChannelEntry>(
  raw: string,
  entries: readonly T[],
): T | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return undefined;
  }
  const exact = entries.find((entry) => normalizeOptionalLowercaseString(entry.id) === normalized);
  if (exact) {
    return exact;
  }
  return entries.find((entry) =>
    (entry.meta.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === normalized,
    ),
  );
}
