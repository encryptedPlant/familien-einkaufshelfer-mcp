// Seeding fictional sample favourites (SPEC §4.6).

import type { Result } from "../core/errors";
import { emptyStore, validateStoreFile } from "../core/store-schema";
import type { Store } from "./store";

export type SeedOutcome =
  | { readonly status: "seeded"; readonly count: number }
  | { readonly status: "not-empty" };

/**
 * Writes the given favourites into a missing or empty store, under the
 * store lock. A non-empty store (any favourite, list entry or processed
 * request) is never overwritten.
 */
export async function seedFavorites(
  store: Store,
  favorites: unknown,
): Promise<Result<SeedOutcome>> {
  const seeded = validateStoreFile({ ...emptyStore(), favorites });
  if (!seeded.ok) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `invalid sample favourites: ${seeded.error.message}`,
      },
    };
  }

  return store.update<SeedOutcome>((current) => {
    const empty =
      current.favorites.length === 0 &&
      current.list.length === 0 &&
      current.processedRequests.length === 0;
    if (!empty) return { ok: true, value: { status: "not-empty" } };
    return {
      ok: true,
      value: { status: "seeded", count: seeded.value.favorites.length },
      next: seeded.value,
    };
  });
}
