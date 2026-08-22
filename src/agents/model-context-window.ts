import type { ModelCatalogEntry } from "./model-catalog.types.js";

/**
 * Resolves a session's selectable context-window choice against the model's
 * catalog-declared options: explicit selection, else the declared default,
 * else the model's scalar window.
 */
export function resolveModelContextWindowProfile(params: {
  catalogEntry?: ModelCatalogEntry;
  selected?: string;
}) {
  const contextWindows = params.catalogEntry?.contextWindows ?? [];
  const contextWindowDefault = params.catalogEntry?.contextWindowDefault;
  const selected = params.selected
    ? contextWindows.find((option) => option.id === params.selected)
    : undefined;
  const fallback = contextWindowDefault
    ? contextWindows.find((option) => option.id === contextWindowDefault)
    : undefined;
  const effective = selected ?? fallback;
  return {
    contextWindow: effective?.id,
    contextWindows,
    contextWindowDefault,
    contextTokens: effective?.contextWindow ?? params.catalogEntry?.contextWindow,
  };
}
