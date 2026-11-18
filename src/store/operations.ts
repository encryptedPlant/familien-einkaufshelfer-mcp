// Store-backed use of the core logic (SPEC §4.5, R5).

import { addToShoppingList, type AddContext } from "../core/add-to-list";
import type { Result } from "../core/errors";
import type { AddResult, AddToShoppingListInput } from "../core/types";
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
