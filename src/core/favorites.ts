// Saving a favourite (SPEC §6.6). Pure, no I/O: the caller passes the
// current state, the time and an ID generator, and persists the result.

import type { Result } from "./errors";
import { normalize } from "./normalize";
import type { Favorite, SaveFavoriteInput, StoreFile } from "./types";

export type SaveFavoriteContext = {
  /** ISO 8601 UTC timestamp for `createdAt`. */
  readonly now: string;
  /** New UUID for the favourite. */
  readonly newId: () => string;
};

export type SaveFavoriteOutcome = {
  readonly store: StoreFile;
  readonly favorite: Favorite;
};

/**
 * Adds a new favourite. Aliases must be unique store-wide after
 * normalisation, also among the aliases of the input itself; a collision
 * fails with DUPLICATE_ALIAS and returns no state. Names may repeat.
 */
export function saveFavorite(
  store: StoreFile,
  input: SaveFavoriteInput,
  context: SaveFavoriteContext,
): Result<SaveFavoriteOutcome> {
  const taken = new Map<string, string>(); // normalised alias → favourite id
  for (const favorite of store.favorites) {
    for (const alias of favorite.aliases)
      taken.set(normalize(alias), favorite.id);
  }

  const seenInInput = new Set<string>();
  for (const alias of input.aliases) {
    const key = normalize(alias);
    const owner = taken.get(key);
    if (owner !== undefined) {
      return duplicateAlias(alias, { favoriteId: owner });
    }
    if (seenInInput.has(key)) {
      return duplicateAlias(alias, { inInput: true });
    }
    seenInInput.add(key);
  }

  const favorite: Favorite = {
    id: context.newId(),
    name: input.name,
    category: input.category,
    aliases: [...input.aliases],
    ...(input.dmArticleNumber !== undefined
      ? { dmArticleNumber: input.dmArticleNumber }
      : {}),
    ...(input.dmUrl !== undefined ? { dmUrl: input.dmUrl } : {}),
    createdAt: context.now,
  };
  return {
    ok: true,
    value: {
      store: { ...store, favorites: [...store.favorites, favorite] },
      favorite,
    },
  };
}

function duplicateAlias(
  alias: string,
  conflict: { favoriteId: string } | { inInput: true },
): Result<never> {
  return {
    ok: false,
    error: {
      code: "DUPLICATE_ALIAS",
      message:
        "favoriteId" in conflict
          ? `alias "${alias}" is already used by another favourite`
          : `alias "${alias}" occurs more than once in this request`,
      details: { alias, ...conflict },
    },
  };
}
