// Store-backed use of the core logic (SPEC §4.5, R5).

import { addToShoppingList, type AddContext } from "../core/add-to-list";
import type { Result } from "../core/errors";
import { saveFavorite, type SaveFavoriteContext } from "../core/favorites";
import type {
  AddResult,
  AddToShoppingListInput,
  Favorite,
  SaveFavoriteInput,
} from "../core/types";
import type { Store } from "./store";

/**
 * Applies a validated request inside one `update`: the requestId lookup, the
 * list change and the processed-request record are written together. A
 * business error or a replay writes nothing. A new request is only reported
 * as successful after the write has completed.
 */
export function addToShoppingListInStore(
  store: Store,
  input: AddToShoppingListInput,
  context: AddContext,
): Promise<Result<AddResult>> {
  return store.update((current) => {
    const outcome = addToShoppingList(current, input, context);
    if (!outcome.ok) return outcome;
    const { result, store: next } = outcome.value;
    return result.replayed
      ? { ok: true, value: result }
      : { ok: true, value: result, next };
  });
}

/**
 * Saves a validated favourite inside one `update`, so the alias check runs
 * under the same lock as the write. A conflict writes nothing; success is
 * only reported after the write has completed.
 */
export function saveFavoriteInStore(
  store: Store,
  input: SaveFavoriteInput,
  context: SaveFavoriteContext,
): Promise<Result<Favorite>> {
  return store.update((current) => {
    const outcome = saveFavorite(current, input, context);
    if (!outcome.ok) return outcome;
    return {
      ok: true,
      value: outcome.value.favorite,
      next: outcome.value.store,
    };
  });
}
