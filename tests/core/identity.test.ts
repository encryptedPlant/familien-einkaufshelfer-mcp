import { describe, expect, test } from "vitest";
import {
  compareProducts,
  findSameProduct,
  identityOfEntry,
  identityOfFavorite,
  identityOfProduct,
} from "../../src/core/identity";
import { normalizeDmUrl } from "../../src/core/normalize";
import type { Favorite, ListEntry } from "../../src/core/types";
import { deepFreeze } from "../helpers/deep-freeze";

const urlX = "https://www.dm.de/beispiel-handcreme-p100123.html";
const urlY = "https://www.dm.de/beispiel-handcreme-gross-p100456.html";

const handCream: Favorite = {
  id: "7c9e0d3a-5b6f-4a21-8e47-aaaaaaaaaaaa",
  name: "Handcreme",
  category: "Körperpflege",
  aliases: [],
  dmArticleNumber: "123",
  dmUrl: urlX,
  createdAt: "2026-01-05T08:00:00.000Z",
};

function entry(
  overrides: Partial<ListEntry> & Pick<ListEntry, "product">,
): ListEntry {
  return {
    id: "e0000000-0000-4000-8000-000000000000",
    quantity: 1,
    status: "open",
    addedAt: "2026-01-06T09:00:00.000Z",
    ...overrides,
  };
}

describe("identity extraction", () => {
  test("a favourite carries its article number and URL plus its id", () => {
    expect(identityOfFavorite(handCream)).toEqual({
      dmArticleNumber: "123",
      dmUrl: urlX,
      favoriteId: handCream.id,
    });
  });

  test("a direct product has no favourite id", () => {
    expect(identityOfProduct({ name: "Handcreme", dmUrl: urlX })).toEqual({
      dmUrl: urlX,
    });
  });

  test("a list entry combines its snapshot identifiers with its favourite id", () => {
    expect(
      identityOfEntry(
        entry({
          product: { name: "Handcreme", dmArticleNumber: "123" },
          favoriteId: handCream.id,
        }),
      ),
    ).toEqual({ dmArticleNumber: "123", favoriteId: handCream.id });
  });
});

describe("compareProducts (SPEC §4.2)", () => {
  test("AC-A3 (identity part): favourite with article number X and direct product with X are the same, both ways", () => {
    const direct = identityOfProduct({
      name: "Handcreme klein",
      dmArticleNumber: "123",
    });
    expect(compareProducts(identityOfFavorite(handCream), direct)).toBe("same");
    expect(compareProducts(direct, identityOfFavorite(handCream))).toBe("same");
  });

  test("AC-A4 (identity part): article number 123 + URL X matches a product with only URL X, both ways", () => {
    const urlOnly = identityOfProduct({ name: "Handcreme", dmUrl: urlX });
    expect(compareProducts(identityOfFavorite(handCream), urlOnly)).toBe(
      "same",
    );
    expect(compareProducts(urlOnly, identityOfFavorite(handCream))).toBe(
      "same",
    );
  });

  test("AC-A5 (identity part): URLs that differ only in query, fragment, trailing slash or host case are the same without article numbers", () => {
    const a = identityOfProduct({
      name: "Handcreme",
      dmUrl: normalizeDmUrl(`${urlX}?utm_source=x`) ?? "",
    });
    const b = identityOfProduct({
      name: "Handcreme",
      dmUrl:
        normalizeDmUrl(
          "https://WWW.dm.de/beispiel-handcreme-p100123.html/#details",
        ) ?? "",
    });
    expect(a.dmUrl).toBe(urlX);
    expect(compareProducts(a, b)).toBe("same");
  });

  test("AC-A6 (identity part): two favourites without dm identifiers but with the same name are different products", () => {
    const candlesA: Favorite = {
      ...handCream,
      id: "7c9e0d3a-5b6f-4a21-8e47-bbbbbbbbbbbb",
      name: "Teelichter",
      aliases: [],
    };
    const candlesB: Favorite = {
      ...candlesA,
      id: "7c9e0d3a-5b6f-4a21-8e47-cccccccccccc",
    };
    const { dmArticleNumber: _a, dmUrl: _b, ...withoutIdsA } = candlesA;
    const { dmArticleNumber: _c, dmUrl: _d, ...withoutIdsB } = candlesB;
    expect(
      compareProducts(
        identityOfFavorite(withoutIdsA),
        identityOfFavorite(withoutIdsB),
      ),
    ).toBe("different");
    expect(
      compareProducts(
        identityOfFavorite(withoutIdsA),
        identityOfFavorite(withoutIdsA),
      ),
    ).toBe("same");
  });

  test("never identifies by name: same name, different article numbers are different", () => {
    expect(
      compareProducts(
        identityOfProduct({ name: "Handcreme", dmArticleNumber: "123" }),
        identityOfProduct({ name: "Handcreme", dmArticleNumber: "456" }),
      ),
    ).toBe("different");
  });

  test("article number on one side and URL on the other are different products", () => {
    expect(compareProducts({ dmArticleNumber: "123" }, { dmUrl: urlX })).toBe(
      "different",
    );
  });

  test("article numbers win over URLs: equal article numbers with different URLs are the same", () => {
    expect(
      compareProducts(
        { dmArticleNumber: "123", dmUrl: urlX },
        { dmArticleNumber: "123", dmUrl: urlY },
      ),
    ).toBe("same");
  });

  test("different article numbers and different URLs are different, not a conflict", () => {
    expect(
      compareProducts(
        { dmArticleNumber: "123", dmUrl: urlX },
        { dmArticleNumber: "456", dmUrl: urlY },
      ),
    ).toBe("different");
  });

  test("a favourite id only counts when neither side has a dm identifier", () => {
    expect(
      compareProducts(
        { favoriteId: handCream.id },
        { dmArticleNumber: "123", favoriteId: handCream.id },
      ),
    ).toBe("different");
  });

  test("AC-A13 (identity part): article number 456 + URL X against 123 + URL X is a conflict", () => {
    expect(
      compareProducts(
        { dmArticleNumber: "456", dmUrl: urlX },
        { dmArticleNumber: "123", dmUrl: urlX },
      ),
    ).toBe("conflict");
  });

  test("does not modify the given identities", () => {
    const a = deepFreeze({ dmArticleNumber: "123", dmUrl: urlX });
    const b = deepFreeze({ dmUrl: urlX });
    expect(compareProducts(a, b)).toBe("same");
  });
});

describe("findSameProduct (SPEC §4.2)", () => {
  // Built inside each test so a failure surfaces per test, not at collection.
  const openEntries = () => [
    identityOfEntry(
      entry({ product: { name: "Handcreme", dmArticleNumber: "123" } }),
    ),
    identityOfEntry(entry({ product: { name: "Handcreme", dmUrl: urlX } })),
    identityOfEntry(
      entry({ product: { name: "Duschgel", dmArticleNumber: "789" } }),
    ),
  ];

  test("returns none when no candidate is the same product", () => {
    expect(findSameProduct({ dmArticleNumber: "999" }, openEntries())).toEqual({
      kind: "none",
    });
  });

  test("returns the single matching candidate", () => {
    expect(findSameProduct({ dmArticleNumber: "789" }, openEntries())).toEqual({
      kind: "match",
      index: 2,
    });
  });

  test("AC-A13 (identity part): an item matching two candidates is a conflict", () => {
    expect(
      findSameProduct({ dmArticleNumber: "123", dmUrl: urlX }, openEntries()),
    ).toEqual({
      kind: "conflict",
      reason: "multiple-matches",
      indices: [0, 1],
    });
  });

  test("AC-A13 (identity part): a contradicting article number for the same URL is a conflict", () => {
    const withBoth = [
      identityOfEntry(
        entry({
          product: { name: "Handcreme", dmArticleNumber: "123", dmUrl: urlX },
        }),
      ),
    ];
    expect(
      findSameProduct({ dmArticleNumber: "456", dmUrl: urlX }, withBoth),
    ).toEqual({
      kind: "conflict",
      reason: "article-number-mismatch",
      indices: [0],
    });
  });

  test("returns none for an empty candidate list", () => {
    expect(findSameProduct({ dmArticleNumber: "123" }, [])).toEqual({
      kind: "none",
    });
  });
});
