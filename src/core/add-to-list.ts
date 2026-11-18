// Applying an add_to_shopping_list request to the store state
// (SPEC §4.4, §4.5, §6.2). Pure, no I/O: the caller passes the current
// state, the time and an ID generator, and persists the returned state
// atomically together with the processed request (storage package).

import type { CoreError, Result } from "./errors";
import { payloadHash } from "./hash";
import {
  findSameProduct,
  identityOfEntry,
  identityOfFavorite,
  identityOfProduct,
  type ProductIdentity,
} from "./identity";
import type {
  AddItem,
  AddResult,
  AddResultEntry,
  AddToShoppingListInput,
  ListEntry,
  ProductRef,
  StoreFile,
} from "./types";

export type AddContext = {
  /** ISO 8601 UTC timestamp used for new entries and the processed request. */
  readonly now: string;
  /** Returns a new unique ID for each created list entry. */
  readonly newId: () => string;
};

export type AddOutcome = {
  /** The new state to persist; the input state itself is never modified. */
  readonly store: StoreFile;
  readonly result: AddResult;
};

const MAX_QUANTITY = 99;

/**
 * Applies a validated request. Order of decisions:
 * 1. A known `requestId` is answered from the stored record before any
 *    favourite is resolved: same payload → original result with
 *    `replayed: true`, different payload → `REQUEST_ID_CONFLICT`.
 * 2. Otherwise the items are applied in input order to the open entries,
 *    including entries created or updated by earlier items of the request.
 * 3. Any error rejects the whole request: no state is returned and the
 *    request is not recorded, so it can be retried with the same requestId.
 */
export function addToShoppingList(
  store: StoreFile,
  input: AddToShoppingListInput,
  context: AddContext,
): Result<AddOutcome> {
  const hash = payloadHash(input.items);

  const processed = store.processedRequests.find(
    (record) => record.requestId === input.requestId,
  );
  if (processed !== undefined) {
    if (processed.payloadHash !== hash) {
      return fail({
        code: "REQUEST_ID_CONFLICT",
        message: `requestId "${input.requestId}" was already used for a different request`,
        details: { requestId: input.requestId },
      });
    }
    return {
      ok: true,
      value: { store, result: { ...processed.result, replayed: true } },
    };
  }

  // Working copy of the list. Entries are replaced, never mutated.
  const list: ListEntry[] = [...store.list];
  const entries: AddResultEntry[] = [];

  for (const [itemIndex, item] of input.items.entries()) {
    const resolved = resolveItem(store, item, itemIndex);
    if (!resolved.ok) return resolved;
    const { product, favoriteId } = resolved.value;

    const openIndices = list.flatMap((e, i) =>
      e.status === "open" ? [i] : [],
    );
    const lookup = findSameProduct(
      identityOf(product, favoriteId),
      openIndices.map((i) => identityOfEntry(list[i] as ListEntry)),
    );

    if (lookup.kind === "conflict") {
      const entryIds = lookup.indices.map(
        (k) => (list[openIndices[k] as number] as ListEntry).id,
      );
      return fail({
        code: "PRODUCT_IDENTITY_CONFLICT",
        message:
          lookup.reason === "multiple-matches"
            ? `item ${itemIndex} is the same product as more than one open entry`
            : `item ${itemIndex} has a different dmArticleNumber than an open entry with the same dmUrl`,
        details: { itemIndex, reason: lookup.reason, entryIds },
      });
    }

    if (lookup.kind === "match") {
      const listIndex = openIndices[lookup.index] as number;
      const existing = list[listIndex] as ListEntry;
      const quantity = existing.quantity + item.quantity;
      if (quantity > MAX_QUANTITY) {
        return fail({
          code: "QUANTITY_LIMIT",
          message: `item ${itemIndex} would raise the quantity of "${existing.product.name}" to ${quantity} (maximum ${MAX_QUANTITY})`,
          details: { itemIndex, entryId: existing.id, quantity },
        });
      }
      const merged: ListEntry = {
        ...existing,
        product: fillMissingIdentifiers(existing.product, product),
        quantity,
      };
      list[listIndex] = merged;
      entries.push(resultEntry(merged, "merged"));
      continue;
    }

    const created: ListEntry = {
      id: context.newId(),
      product,
      ...(favoriteId !== undefined ? { favoriteId } : {}),
      quantity: item.quantity,
      status: "open",
      addedAt: context.now,
    };
    list.push(created);
    entries.push(resultEntry(created, "created"));
  }

  const result: AddResult = {
    requestId: input.requestId,
    replayed: false,
    entries,
  };
  return {
    ok: true,
    value: {
      store: {
        ...store,
        list,
        processedRequests: [
          ...store.processedRequests,
          {
            requestId: input.requestId,
            payloadHash: hash,
            result,
            processedAt: context.now,
          },
        ],
      },
      result,
    },
  };
}

type ResolvedItem = {
  readonly product: ProductRef;
  readonly favoriteId?: string;
};

/** Product snapshot for an item; a favourite contributes its current data. */
function resolveItem(
  store: StoreFile,
  item: AddItem,
  itemIndex: number,
): Result<ResolvedItem> {
  if ("product" in item) return { ok: true, value: { product: item.product } };
  const favorite = store.favorites.find((f) => f.id === item.favoriteId);
  if (favorite === undefined) {
    return fail({
      code: "FAVORITE_NOT_FOUND",
      message: `favourite "${item.favoriteId}" (item ${itemIndex}) does not exist`,
      details: { itemIndex, favoriteId: item.favoriteId },
    });
  }
  const product: ProductRef = {
    name: favorite.name,
    category: favorite.category,
    ...(favorite.dmArticleNumber !== undefined
      ? { dmArticleNumber: favorite.dmArticleNumber }
      : {}),
    ...(favorite.dmUrl !== undefined ? { dmUrl: favorite.dmUrl } : {}),
  };
  return { ok: true, value: { product, favoriteId: favorite.id } };
}

function identityOf(
  product: ProductRef,
  favoriteId: string | undefined,
): ProductIdentity {
  const identity = identityOfProduct(product);
  return favoriteId !== undefined ? { ...identity, favoriteId } : identity;
}

/** Fills a missing DAN or URL from the item; existing values are never overwritten. */
function fillMissingIdentifiers(
  snapshot: ProductRef,
  item: ProductRef,
): ProductRef {
  return {
    ...snapshot,
    ...(snapshot.dmArticleNumber === undefined &&
    item.dmArticleNumber !== undefined
      ? { dmArticleNumber: item.dmArticleNumber }
      : {}),
    ...(snapshot.dmUrl === undefined && item.dmUrl !== undefined
      ? { dmUrl: item.dmUrl }
      : {}),
  };
}

function resultEntry(
  entry: ListEntry,
  action: AddResultEntry["action"],
): AddResultEntry {
  return {
    entryId: entry.id,
    name: entry.product.name,
    quantity: entry.quantity,
    action,
  };
}

function fail(error: CoreError): {
  readonly ok: false;
  readonly error: CoreError;
} {
  return { ok: false, error };
}
