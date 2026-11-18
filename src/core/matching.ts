// Matching of search terms to favourites (SPEC §4.3). Pure, no I/O.

import { normalize } from "./normalize";
import type {
  Favorite,
  ResolveItemRequest,
  ResolveItemsInput,
  ResolveItemsOutput,
  ResolveResult,
} from "./types";

type Stage = (favorite: Favorite, key: string) => boolean;

/**
 * Stages in priority order: alias, name, category. The first stage with at
 * least one hit decides. Exact matches on the normalised text only; no
 * substring or fuzzy matching.
 */
const stages: readonly Stage[] = [
  (favorite, key) => favorite.aliases.some((alias) => normalize(alias) === key),
  (favorite, key) => normalize(favorite.name) === key,
  (favorite, key) => normalize(favorite.category) === key,
];

/** Resolves each requested term; results keep the input order. */
export function resolveItems(
  input: ResolveItemsInput,
  favorites: readonly Favorite[],
): ResolveItemsOutput {
  return { results: input.items.map((item) => resolveItem(item, favorites)) };
}

function resolveItem(
  { term, quantity }: ResolveItemRequest,
  favorites: readonly Favorite[],
): ResolveResult {
  const key = normalize(term);
  for (const matches of stages) {
    const hits = favorites.filter((favorite) => matches(favorite, key));
    const [first] = hits;
    if (first === undefined) continue;
    // Aliases are unique store-wide, so an alias stage has at most one hit
    // in consistent data; several hits are still reported, never picked.
    if (hits.length === 1)
      return { term, quantity, status: "resolved", favorite: first };
    return { term, quantity, status: "ambiguous", candidates: hits };
  }
  return { term, quantity, status: "unknown" };
}
