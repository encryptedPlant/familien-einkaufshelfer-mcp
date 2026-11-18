import { describe, expect, test } from "vitest";
import type { Result } from "../../src/core/errors";
import {
  validateAddToShoppingListInput,
  validateResolveItemsInput,
} from "../../src/core/validation";
import { deepFreeze } from "../helpers/deep-freeze";

function expectValidationError(result: Result<unknown>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).not.toBe("");
  }
}

function valueOf<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(
      `expected ok, got ${result.error.code}: ${result.error.message}`,
    );
  return result.value;
}

describe("validateResolveItemsInput (SPEC §6.1)", () => {
  test("AC-R7: empty items list is a VALIDATION_ERROR", () => {
    expectValidationError(validateResolveItemsInput({ items: [] }));
  });

  test.each([
    ["empty term", { term: "" }],
    ["whitespace-only term", { term: " \t " }],
    ["quantity 0", { term: "Zahnpasta", quantity: 0 }],
    ["quantity 100", { term: "Zahnpasta", quantity: 100 }],
    ["quantity 1.5", { term: "Zahnpasta", quantity: 1.5 }],
  ])("AC-R7: %s is a VALIDATION_ERROR", (_label, item) => {
    expectValidationError(validateResolveItemsInput({ items: [item] }));
  });

  test("trims the term and defaults the quantity to 1", () => {
    expect(
      valueOf(validateResolveItemsInput({ items: [{ term: "  Spüli " }] })),
    ).toEqual({
      items: [{ term: "Spüli", quantity: 1 }],
    });
  });

  test("keeps the given quantity at the bounds 1 and 99", () => {
    const value = valueOf(
      validateResolveItemsInput({
        items: [
          { term: "Spüli", quantity: 1 },
          { term: "Zahnpasta", quantity: 99 },
        ],
      }),
    );
    expect(value.items.map((item) => item.quantity)).toEqual([1, 99]);
  });

  test("applies the length limit (1–200) to the trimmed term", () => {
    expect(
      validateResolveItemsInput({ items: [{ term: ` ${"a".repeat(200)} ` }] })
        .ok,
    ).toBe(true);
    expectValidationError(
      validateResolveItemsInput({ items: [{ term: "a".repeat(201) }] }),
    );
  });

  test("accepts 50 items and rejects 51", () => {
    const items = (n: number) =>
      Array.from({ length: n }, () => ({ term: "Spüli" }));
    expect(validateResolveItemsInput({ items: items(50) }).ok).toBe(true);
    expectValidationError(validateResolveItemsInput({ items: items(51) }));
  });

  test.each([
    ["undefined", undefined],
    ["a string", "Zahnpasta"],
    ["items not an array", { items: "Zahnpasta" }],
    ["term not a string", { items: [{ term: 42 }] }],
  ])("rejects malformed input: %s", (_label, input) => {
    expectValidationError(validateResolveItemsInput(input));
  });

  test("does not modify the given input", () => {
    const input = deepFreeze({ items: [{ term: "  Spüli  " }] });
    expect(validateResolveItemsInput(input).ok).toBe(true);
    expect(input).toEqual({ items: [{ term: "  Spüli  " }] });
  });
});

describe("validateAddToShoppingListInput (SPEC §6.2)", () => {
  const favoriteItem = {
    favoriteId: "0b1f6a52-3c4d-4e8f-9a01-222222222222",
    quantity: 2,
  };
  const productItem = {
    product: {
      name: "Zahnseide mint",
      category: "Zahnpflege",
      dmArticleNumber: "100007",
      dmUrl: "https://www.dm.de/beispiel-zahnseide-mint-p100007.html",
    },
    quantity: 1,
  };

  test("accepts a favourite item and a direct product item", () => {
    expect(
      valueOf(
        validateAddToShoppingListInput({
          requestId: "req-1",
          items: [favoriteItem, productItem],
        }),
      ),
    ).toEqual({ requestId: "req-1", items: [favoriteItem, productItem] });
  });

  test.each([
    [
      "without article number and URL",
      { name: "Zahnseide mint", category: "Zahnpflege" },
    ],
    [
      "with a non-dm URL",
      {
        name: "Zahnseide mint",
        dmUrl: "https://www.example.com/zahnseide-mint.html",
      },
    ],
    ["with a whitespace-only name", { name: "   ", dmArticleNumber: "100007" }],
  ])("AC-A12: a direct product %s is a VALIDATION_ERROR", (_label, product) => {
    expectValidationError(
      validateAddToShoppingListInput({
        requestId: "req-1",
        items: [{ product, quantity: 1 }],
      }),
    );
  });

  test.each([
    "https://www.dm.de",
    "https://www.dm.de/",
    "https://www.dm.de/?utm_source=x",
    "https://www.dm.de/#angebote",
  ])(
    "AC-A12: the dm start page %s as dmUrl is a VALIDATION_ERROR, with or without article number",
    (dmUrl) => {
      for (const product of [
        { name: "Zahnseide mint", dmUrl },
        { name: "Zahnseide mint", dmArticleNumber: "100007", dmUrl },
      ]) {
        const result = validateAddToShoppingListInput({
          requestId: "req-1",
          items: [{ product, quantity: 1 }],
        });
        expectValidationError(result);
        if (!result.ok) {
          expect(result.error.details).toMatchObject({
            issues: [{ path: "items.0.product.dmUrl" }],
          });
        }
      }
    },
  );

  test("a direct product with only an article number or only a URL is valid", () => {
    expect(
      validateAddToShoppingListInput({
        requestId: "req-1",
        items: [
          {
            product: { name: "Zahnseide mint", dmArticleNumber: "100007" },
            quantity: 1,
          },
          {
            product: {
              name: "Zahnseide mint",
              dmUrl: "https://www.dm.de/beispiel-zahnseide-mint-p100007.html",
            },
            quantity: 1,
          },
        ],
      }).ok,
    ).toBe(true);
  });

  test("trims text fields and stores the dm URL normalised", () => {
    const value = valueOf(
      validateAddToShoppingListInput({
        requestId: "req-1",
        items: [
          {
            product: {
              name: "  Zahnseide mint ",
              category: " Zahnpflege ",
              dmArticleNumber: " 100007 ",
              dmUrl:
                "https://DM.de/beispiel-zahnseide-mint-p100007.html/?utm_source=x#top",
            },
            quantity: 3,
          },
        ],
      }),
    );
    expect(value.items).toEqual([
      {
        product: {
          name: "Zahnseide mint",
          category: "Zahnpflege",
          dmArticleNumber: "100007",
          dmUrl: "https://www.dm.de/beispiel-zahnseide-mint-p100007.html",
        },
        quantity: 3,
      },
    ]);
  });

  test("AC-A8 (normalisation part): equivalent spellings validate to identical items", () => {
    const spelledA = validateAddToShoppingListInput({
      requestId: "req-1",
      items: [
        favoriteItem,
        {
          product: {
            name: "Zahnseide mint",
            dmUrl: "https://www.dm.de/beispiel-zahnseide-mint-p100007.html",
          },
          quantity: 1,
        },
      ],
    });
    const spelledB = validateAddToShoppingListInput({
      requestId: "req-1",
      items: [
        favoriteItem,
        {
          product: {
            name: "  Zahnseide mint  ",
            dmUrl:
              "https://WWW.DM.DE/beispiel-zahnseide-mint-p100007.html/?ref=newsletter",
          },
          quantity: 1,
        },
      ],
    });
    expect(valueOf(spelledB)).toEqual(valueOf(spelledA));
  });

  test.each([
    ["empty", ""],
    ["a space", "req 1"],
    ["an umlaut", "anfrage-ä"],
    ["129 characters", "a".repeat(129)],
    ["not a string", 42],
  ])("rejects a requestId with %s", (_label, requestId) => {
    expectValidationError(
      validateAddToShoppingListInput({ requestId, items: [favoriteItem] }),
    );
  });

  test("accepts a requestId of 128 characters from [A-Za-z0-9_-]", () => {
    const requestId = "Ab9_-".repeat(25) + "xyz";
    expect(requestId).toHaveLength(128);
    expect(
      validateAddToShoppingListInput({ requestId, items: [favoriteItem] }).ok,
    ).toBe(true);
  });

  test.each([
    ["missing", { favoriteId: favoriteItem.favoriteId }],
    ["0", { ...favoriteItem, quantity: 0 }],
    ["100", { ...favoriteItem, quantity: 100 }],
    ["1.5", { ...favoriteItem, quantity: 1.5 }],
  ])("rejects quantity %s", (_label, item) => {
    expectValidationError(
      validateAddToShoppingListInput({ requestId: "req-1", items: [item] }),
    );
  });

  test("accepts 50 items and rejects 0 or 51", () => {
    const items = (n: number) => Array.from({ length: n }, () => favoriteItem);
    expect(
      validateAddToShoppingListInput({ requestId: "req-1", items: items(50) })
        .ok,
    ).toBe(true);
    expectValidationError(
      validateAddToShoppingListInput({ requestId: "req-1", items: items(0) }),
    );
    expectValidationError(
      validateAddToShoppingListInput({ requestId: "req-1", items: items(51) }),
    );
  });

  test.each([
    ["letters", "10000A"],
    ["14 digits", "1".repeat(14)],
    ["whitespace only", "  "],
  ])("rejects an article number with %s", (_label, dmArticleNumber) => {
    expectValidationError(
      validateAddToShoppingListInput({
        requestId: "req-1",
        items: [
          { product: { name: "Zahnseide mint", dmArticleNumber }, quantity: 1 },
        ],
      }),
    );
  });

  test.each([
    [
      "a name of 201 characters",
      { name: "a".repeat(201), dmArticleNumber: "100007" },
    ],
    [
      "a whitespace-only category",
      { name: "Zahnseide mint", category: " ", dmArticleNumber: "100007" },
    ],
    [
      "a category of 101 characters",
      {
        name: "Zahnseide mint",
        category: "a".repeat(101),
        dmArticleNumber: "100007",
      },
    ],
  ])("rejects a direct product with %s", (_label, product) => {
    expectValidationError(
      validateAddToShoppingListInput({
        requestId: "req-1",
        items: [{ product, quantity: 1 }],
      }),
    );
  });

  test("rejects an item that names both a favourite and a direct product", () => {
    expectValidationError(
      validateAddToShoppingListInput({
        requestId: "req-1",
        items: [
          {
            favoriteId: favoriteItem.favoriteId,
            product: productItem.product,
            quantity: 1,
          },
        ],
      }),
    );
  });

  test("rejects an item that names neither a favourite nor a direct product", () => {
    expectValidationError(
      validateAddToShoppingListInput({
        requestId: "req-1",
        items: [{ quantity: 1 }],
      }),
    );
  });

  test("does not modify the given input", () => {
    const input = deepFreeze({
      requestId: "req-1",
      items: [
        {
          product: {
            name: " Zahnseide mint ",
            dmUrl: "https://dm.de/beispiel-zahnseide-mint-p100007.html/",
          },
          quantity: 1,
        },
      ],
    });
    const snapshot = structuredClone(input);
    expect(validateAddToShoppingListInput(input).ok).toBe(true);
    expect(input).toEqual(snapshot);
  });
});
