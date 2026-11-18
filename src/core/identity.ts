// Product identity (SPEC §4.2). Pure functions, no I/O.
//
// dm URLs are expected in normalised form (see normalizeDmUrl); validation
// and storage guarantee that, so identifiers are compared verbatim here.

import type { Favorite, ListEntry, ProductRef } from "./types";

/** The identifiers that decide whether two products are the same. */
export type ProductIdentity = {
  readonly dmArticleNumber?: string | undefined;
  readonly dmUrl?: string | undefined;
  readonly favoriteId?: string | undefined;
};

export type ProductComparison = "same" | "different" | "conflict";

export type SameProductLookup =
  | { readonly kind: "none" }
  | { readonly kind: "match"; readonly index: number }
  | {
      readonly kind: "conflict";
      readonly reason: "article-number-mismatch" | "multiple-matches";
      readonly indices: readonly number[];
    };

/** An item that references a favourite carries the favourite's DAN and URL. */
export function identityOfFavorite(favorite: Favorite): ProductIdentity {
  return identity(favorite, favorite.id);
}

/** A directly added product (no favourite). */
export function identityOfProduct(product: ProductRef): ProductIdentity {
  return identity(product, undefined);
}

/** A list entry: its product snapshot plus the favourite it was created from. */
export function identityOfEntry(entry: ListEntry): ProductIdentity {
  return identity(entry.product, entry.favoriteId);
}

function identity(
  product: ProductRef,
  favoriteId: string | undefined,
): ProductIdentity {
  return {
    ...(product.dmArticleNumber !== undefined
      ? { dmArticleNumber: product.dmArticleNumber }
      : {}),
    ...(product.dmUrl !== undefined ? { dmUrl: product.dmUrl } : {}),
    ...(favoriteId !== undefined ? { favoriteId } : {}),
  };
}

/**
 * Compares two products by the rules of SPEC §4.2:
 * 1. both have a DAN → same if the DANs are equal;
 * 2. otherwise both have a URL → same if the URLs are equal;
 * 3. otherwise neither has a DAN or URL → same if both come from the same favourite;
 * 4. in all other cases different.
 * Differing DANs with equal URLs are a conflict. The name is never used.
 */
export function compareProducts(
  a: ProductIdentity,
  b: ProductIdentity,
): ProductComparison {
  const aDan = a.dmArticleNumber;
  const bDan = b.dmArticleNumber;
  if (aDan !== undefined && bDan !== undefined) {
    if (aDan === bDan) return "same";
    return a.dmUrl !== undefined && a.dmUrl === b.dmUrl
      ? "conflict"
      : "different";
  }
  if (a.dmUrl !== undefined && b.dmUrl !== undefined) {
    return a.dmUrl === b.dmUrl ? "same" : "different";
  }
  const aHasDmId = aDan !== undefined || a.dmUrl !== undefined;
  const bHasDmId = bDan !== undefined || b.dmUrl !== undefined;
  if (!aHasDmId && !bHasDmId) {
    return a.favoriteId !== undefined && a.favoriteId === b.favoriteId
      ? "same"
      : "different";
  }
  return "different";
}

/**
 * Finds the candidate that is the same product as `item`. A contradicting
 * DAN for an equal URL, or more than one matching candidate, is a conflict
 * (SPEC §4.2). Which candidates to pass (e.g. only open entries) is up to
 * the caller.
 */
export function findSameProduct(
  item: ProductIdentity,
  candidates: readonly ProductIdentity[],
): SameProductLookup {
  const matches: number[] = [];
  const conflicts: number[] = [];
  candidates.forEach((candidate, index) => {
    const comparison = compareProducts(item, candidate);
    if (comparison === "same") matches.push(index);
    else if (comparison === "conflict") conflicts.push(index);
  });

  if (conflicts.length > 0) {
    return {
      kind: "conflict",
      reason: "article-number-mismatch",
      indices: conflicts,
    };
  }
  const [only] = matches;
  if (matches.length > 1)
    return { kind: "conflict", reason: "multiple-matches", indices: matches };
  if (only !== undefined) return { kind: "match", index: only };
  return { kind: "none" };
}
