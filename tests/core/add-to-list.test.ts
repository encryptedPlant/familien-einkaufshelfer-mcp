import { describe, expect, test } from "vitest";
import {
  addToShoppingList,
  type AddContext,
  type AddOutcome,
} from "../../src/core/add-to-list";
import type { ErrorCode, Result } from "../../src/core/errors";
import { payloadHash } from "../../src/core/hash";
import type {
  AddToShoppingListInput,
  Favorite,
  ListEntry,
  StoreFile,
} from "../../src/core/types";
import { validateAddToShoppingListInput } from "../../src/core/validation";
import {
  dishSoap,
  favorites,
  toothpasteMint,
  wetWipes,
} from "../fixtures/favorites";
import { deepFreeze } from "../helpers/deep-freeze";

const T1 = "2026-02-01T10:00:00.000Z";
const T2 = "2026-02-02T11:30:00.000Z";
const WET_WIPES_URL = wetWipes.dmUrl ?? "";
const DISH_SOAP_URL = dishSoap.dmUrl ?? "";

/** Deterministic context: fixed time and sequential IDs. */
function context(now = T1, prefix = "entry"): AddContext {
  let n = 0;
  return { now, newId: () => `${prefix}-${++n}` };
}

/** A frozen store; every test checks it is unchanged after the call. */
function makeStore(partial: Partial<StoreFile> = {}): StoreFile {
  return deepFreeze(
    structuredClone({
      version: 1 as const,
      favorites,
      list: [],
      processedRequests: [],
      ...partial,
    }),
  );
}

/** Validated, frozen request built from raw tool input. */
function request(requestId: string, items: unknown): AddToShoppingListInput {
  const result = validateAddToShoppingListInput({ requestId, items });
  if (!result.ok) throw new Error(result.error.message);
  return deepFreeze(result.value);
}

function entry(
  fields: Pick<ListEntry, "id" | "product" | "quantity"> & Partial<ListEntry>,
): ListEntry {
  return { status: "open", addedAt: "2026-01-20T09:00:00.000Z", ...fields };
}

function ok(result: Result<AddOutcome>): AddOutcome {
  if (!result.ok) {
    throw new Error(
      `expected ok, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

function expectError(result: Result<AddOutcome>, code: ErrorCode) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected an error");
  expect(result.error.code).toBe(code);
  // An error never carries a (partially) updated state.
  expect(result).not.toHaveProperty("value");
  return result.error;
}

/** Runs `addToShoppingList` and asserts the inputs are unchanged afterwards. */
function run(
  store: StoreFile,
  input: AddToShoppingListInput,
  ctx: AddContext = context(),
): Result<AddOutcome> {
  const storeBefore = structuredClone(store);
  const inputBefore = structuredClone(input);
  const result = addToShoppingList(store, input, ctx);
  expect(store).toEqual(storeBefore);
  expect(input).toEqual(inputBefore);
  return result;
}

const wetWipesSnapshot = {
  name: wetWipes.name,
  category: wetWipes.category,
  dmArticleNumber: "100001",
  dmUrl: WET_WIPES_URL,
};

describe("addToShoppingList – merging (SPEC §4.4)", () => {
  test("AC-A1: a favourite not on the open list creates one open entry with the given quantity", () => {
    const input = request("req-1", [{ favoriteId: wetWipes.id, quantity: 2 }]);
    const { store, result } = ok(run(makeStore(), input));

    expect(store.list).toEqual([
      {
        id: "entry-1",
        product: wetWipesSnapshot,
        favoriteId: wetWipes.id,
        quantity: 2,
        status: "open",
        addedAt: T1,
      },
    ]);
    expect(result).toEqual({
      requestId: "req-1",
      replayed: false,
      entries: [
        {
          entryId: "entry-1",
          name: wetWipes.name,
          quantity: 2,
          action: "created",
        },
      ],
    });
    expect(store.processedRequests).toEqual([
      {
        requestId: "req-1",
        payloadHash: payloadHash(input.items),
        result,
        processedAt: T1,
      },
    ]);
    expect(store.favorites).toEqual(favorites);
  });

  test("AC-A2: a new request for a product already on the open list increases its quantity", () => {
    const first = ok(
      run(
        makeStore(),
        request("req-1", [{ favoriteId: wetWipes.id, quantity: 2 }]),
      ),
    );
    const second = ok(
      run(
        deepFreeze(first.store),
        request("req-2", [{ favoriteId: wetWipes.id, quantity: 3 }]),
        context(T2, "later"),
      ),
    );

    expect(second.store.list).toHaveLength(1);
    expect(second.store.list[0]).toMatchObject({
      id: "entry-1",
      quantity: 5,
      addedAt: T1,
    });
    expect(second.result.entries).toEqual([
      {
        entryId: "entry-1",
        name: wetWipes.name,
        quantity: 5,
        action: "merged",
      },
    ]);
    expect(second.store.processedRequests.map((r) => r.requestId)).toEqual([
      "req-1",
      "req-2",
    ]);
  });

  test("applies items in input order; the same product twice in one request adds up", () => {
    const { store, result } = ok(
      run(
        makeStore(),
        request("req-1", [
          { favoriteId: wetWipes.id, quantity: 2 },
          { favoriteId: toothpasteMint.id, quantity: 1 },
          {
            product: {
              name: "Feuchttücher (direkt)",
              dmArticleNumber: "100001",
            },
            quantity: 3,
          },
        ]),
      ),
    );

    expect(result.entries).toEqual([
      {
        entryId: "entry-1",
        name: wetWipes.name,
        quantity: 2,
        action: "created",
      },
      {
        entryId: "entry-2",
        name: toothpasteMint.name,
        quantity: 1,
        action: "created",
      },
      {
        entryId: "entry-1",
        name: wetWipes.name,
        quantity: 5,
        action: "merged",
      },
    ]);
    expect(store.list.map((e) => [e.id, e.quantity])).toEqual([
      ["entry-1", 5],
      ["entry-2", 1],
    ]);
  });

  test("AC-A3: a direct product with article number X merges into an entry created via a favourite with X", () => {
    const base = makeStore({
      list: [
        entry({
          id: "e-fav",
          product: wetWipesSnapshot,
          favoriteId: wetWipes.id,
          quantity: 1,
        }),
      ],
    });
    const { store, result } = ok(
      run(
        base,
        request("req-1", [
          {
            product: { name: "Feuchttücher", dmArticleNumber: "100001" },
            quantity: 2,
          },
        ]),
      ),
    );
    expect(store.list).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      entryId: "e-fav",
      quantity: 3,
      action: "merged",
    });
  });

  test("AC-A3: a favourite with article number X merges into a directly added entry with X", () => {
    const base = makeStore({
      list: [
        entry({
          id: "e-direct",
          product: { name: "Feuchttücher", dmArticleNumber: "100001" },
          quantity: 1,
        }),
      ],
    });
    const { store } = ok(
      run(base, request("req-1", [{ favoriteId: wetWipes.id, quantity: 1 }])),
    );
    expect(store.list).toHaveLength(1);
    expect(store.list[0]).toMatchObject({ id: "e-direct", quantity: 2 });
  });

  test("AC-A4: article number + URL X on the list; a direct product with only URL X merges", () => {
    const base = makeStore({
      list: [
        entry({
          id: "e-fav",
          product: wetWipesSnapshot,
          favoriteId: wetWipes.id,
          quantity: 1,
        }),
      ],
    });
    const { store } = ok(
      run(
        base,
        request("req-1", [
          {
            product: { name: "Feuchttücher", dmUrl: WET_WIPES_URL },
            quantity: 1,
          },
        ]),
      ),
    );
    expect(store.list).toEqual([
      { ...base.list[0], quantity: 2, product: wetWipesSnapshot },
    ]);
  });

  test("AC-A4: reverse order merges too, and the entry then carries both article number and URL", () => {
    const base = makeStore({
      list: [
        entry({
          id: "e-direct",
          product: { name: "Feuchttücher Vorrat", dmUrl: WET_WIPES_URL },
          quantity: 1,
        }),
      ],
    });
    const { store, result } = ok(
      run(base, request("req-1", [{ favoriteId: wetWipes.id, quantity: 2 }])),
    );
    expect(store.list).toEqual([
      {
        id: "e-direct",
        // Snapshot name stays; only the missing identifier is filled in.
        product: {
          name: "Feuchttücher Vorrat",
          dmUrl: WET_WIPES_URL,
          dmArticleNumber: "100001",
        },
        quantity: 3,
        status: "open",
        addedAt: "2026-01-20T09:00:00.000Z",
      },
    ]);
    expect(result.entries[0]?.name).toBe("Feuchttücher Vorrat");
  });

  test("never overwrites an identifier the entry already has", () => {
    const otherUrl =
      "https://www.dm.de/beispiel-feuchttuecher-alt-p100001.html";
    const base = makeStore({
      list: [
        entry({
          id: "e-direct",
          product: {
            name: "Feuchttücher",
            dmArticleNumber: "100001",
            dmUrl: otherUrl,
          },
          quantity: 1,
        }),
      ],
    });
    const { store } = ok(
      run(base, request("req-1", [{ favoriteId: wetWipes.id, quantity: 1 }])),
    );
    expect(store.list[0]?.product).toEqual({
      name: "Feuchttücher",
      dmArticleNumber: "100001",
      dmUrl: otherUrl,
    });
  });

  test("AC-A5: without article numbers, URLs differing in query, fragment, trailing slash or host case merge", () => {
    const base = makeStore({
      list: [
        entry({
          id: "e-direct",
          product: { name: "Spülmittel", dmUrl: DISH_SOAP_URL },
          quantity: 1,
        }),
      ],
    });
    const respelled =
      "https://WWW.DM.DE/beispiel-spuelmittel-zitrone-p100006.html/?utm_source=x#top";
    const { store } = ok(
      run(
        base,
        request("req-1", [
          { product: { name: "Spülmittel", dmUrl: respelled }, quantity: 4 },
        ]),
      ),
    );
    expect(store.list).toHaveLength(1);
    expect(store.list[0]).toMatchObject({ id: "e-direct", quantity: 5 });
  });

  test("AC-A6: two favourites without dm identifiers but with the same name produce two entries", () => {
    const candles = (id: string): Favorite => ({
      id,
      name: "Teelichter",
      category: "Haushalt",
      aliases: [],
      createdAt: "2026-01-05T08:00:00.000Z",
    });
    const a = candles("0b1f6a52-3c4d-4e8f-9a01-aaaaaaaaaaaa");
    const b = candles("0b1f6a52-3c4d-4e8f-9a01-bbbbbbbbbbbb");
    const { store, result } = ok(
      run(
        makeStore({ favorites: [a, b] }),
        request("req-1", [
          { favoriteId: a.id, quantity: 1 },
          { favoriteId: b.id, quantity: 1 },
          { favoriteId: a.id, quantity: 1 },
        ]),
      ),
    );
    expect(store.list.map((e) => [e.favoriteId, e.quantity])).toEqual([
      [a.id, 2],
      [b.id, 1],
    ]);
    expect(result.entries.map((e) => e.action)).toEqual([
      "created",
      "created",
      "merged",
    ]);
  });

  test("AC-A7: if the only entry for a product is bought, a new open entry is created and the bought one is unchanged", () => {
    const bought = entry({
      id: "e-bought",
      product: wetWipesSnapshot,
      favoriteId: wetWipes.id,
      quantity: 2,
      status: "bought",
      boughtAt: "2026-01-25T16:00:00.000Z",
    });
    const { store, result } = ok(
      run(
        makeStore({ list: [bought] }),
        request("req-1", [{ favoriteId: wetWipes.id, quantity: 1 }]),
      ),
    );
    expect(store.list).toEqual([
      bought,
      {
        id: "entry-1",
        product: wetWipesSnapshot,
        favoriteId: wetWipes.id,
        quantity: 1,
        status: "open",
        addedAt: T1,
      },
    ]);
    expect(result.entries[0]?.action).toBe("created");
  });

  test("merges into the open entry and leaves a bought entry of the same product untouched", () => {
    const bought = entry({
      id: "e-bought",
      product: wetWipesSnapshot,
      quantity: 2,
      status: "bought",
      boughtAt: "2026-01-25T16:00:00.000Z",
    });
    const open = entry({
      id: "e-open",
      product: wetWipesSnapshot,
      quantity: 1,
    });
    const { store } = ok(
      run(
        makeStore({ list: [bought, open] }),
        request("req-1", [{ favoriteId: wetWipes.id, quantity: 1 }]),
      ),
    );
    expect(store.list).toEqual([bought, { ...open, quantity: 2 }]);
  });

  test("a contradicting article number on a bought entry is not a conflict (only open entries are compared)", () => {
    const bought = entry({
      id: "e-bought",
      product: {
        name: "Feuchttücher",
        dmArticleNumber: "999",
        dmUrl: WET_WIPES_URL,
      },
      quantity: 1,
      status: "bought",
      boughtAt: "2026-01-25T16:00:00.000Z",
    });
    const { store } = ok(
      run(
        makeStore({ list: [bought] }),
        request("req-1", [{ favoriteId: wetWipes.id, quantity: 1 }]),
      ),
    );
    expect(store.list).toHaveLength(2);
  });

  test("accepts a resulting quantity of exactly 99", () => {
    const base = makeStore({
      list: [entry({ id: "e-1", product: wetWipesSnapshot, quantity: 98 })],
    });
    const { store } = ok(
      run(base, request("req-1", [{ favoriteId: wetWipes.id, quantity: 1 }])),
    );
    expect(store.list[0]?.quantity).toBe(99);
  });
});

describe("addToShoppingList – rejecting a faulty request as a whole (SPEC §4.4, §4.7)", () => {
  const openWetWipes = entry({
    id: "e-1",
    product: wetWipesSnapshot,
    favoriteId: wetWipes.id,
    quantity: 98,
  });

  test("AC-A10: one unknown favoriteId after valid items fails with FAVORITE_NOT_FOUND and records nothing", () => {
    const base = makeStore({ list: [openWetWipes] });
    const error = expectError(
      run(
        base,
        request("req-1", [
          { favoriteId: toothpasteMint.id, quantity: 1 },
          { favoriteId: "0b1f6a52-3c4d-4e8f-9a01-ffffffffffff", quantity: 1 },
        ]),
      ),
      "FAVORITE_NOT_FOUND",
    );
    expect(error.details).toMatchObject({
      itemIndex: 1,
      favoriteId: "0b1f6a52-3c4d-4e8f-9a01-ffffffffffff",
    });
  });

  test("AC-A11: a resulting quantity of 100 fails with QUANTITY_LIMIT, even after valid items", () => {
    const error = expectError(
      run(
        makeStore({ list: [openWetWipes] }),
        request("req-1", [
          { favoriteId: toothpasteMint.id, quantity: 5 },
          { favoriteId: wetWipes.id, quantity: 2 },
        ]),
      ),
      "QUANTITY_LIMIT",
    );
    expect(error.details).toMatchObject({
      itemIndex: 1,
      entryId: "e-1",
      quantity: 100,
    });
  });

  test("AC-A11: duplicates within one request count towards the limit", () => {
    expectError(
      run(
        makeStore(),
        request("req-1", [
          { favoriteId: wetWipes.id, quantity: 60 },
          { favoriteId: wetWipes.id, quantity: 40 },
        ]),
      ),
      "QUANTITY_LIMIT",
    );
  });

  test("AC-A13: article number 456 + URL X against an open entry with 123 + URL X fails, even after valid items", () => {
    const base = makeStore({
      list: [
        entry({
          id: "e-123",
          product: {
            name: "Handcreme",
            dmArticleNumber: "123",
            dmUrl: "https://www.dm.de/beispiel-handcreme-p100123.html",
          },
          quantity: 1,
        }),
      ],
    });
    const error = expectError(
      run(
        base,
        request("req-1", [
          { favoriteId: toothpasteMint.id, quantity: 1 },
          {
            product: {
              name: "Handcreme",
              dmArticleNumber: "456",
              dmUrl: "https://www.dm.de/beispiel-handcreme-p100123.html",
            },
            quantity: 1,
          },
        ]),
      ),
      "PRODUCT_IDENTITY_CONFLICT",
    );
    expect(error.details).toMatchObject({ itemIndex: 1, entryIds: ["e-123"] });
  });

  test("AC-A13: an item that is the same product as two open entries fails", () => {
    const base = makeStore({
      list: [
        entry({
          id: "e-dan",
          product: { name: "Feuchttücher", dmArticleNumber: "100001" },
          quantity: 1,
        }),
        entry({
          id: "e-url",
          product: { name: "Feuchttücher", dmUrl: WET_WIPES_URL },
          quantity: 1,
        }),
      ],
    });
    const error = expectError(
      run(base, request("req-1", [{ favoriteId: wetWipes.id, quantity: 1 }])),
      "PRODUCT_IDENTITY_CONFLICT",
    );
    expect(error.details).toMatchObject({ entryIds: ["e-dan", "e-url"] });
  });

  test("AC-A10: a failed request is not recorded; a corrected retry with the same requestId is processed normally", () => {
    const base = makeStore({ list: [openWetWipes] });
    expectError(
      run(
        base,
        request("req-1", [
          { favoriteId: "0b1f6a52-3c4d-4e8f-9a01-ffffffffffff", quantity: 1 },
        ]),
      ),
      "FAVORITE_NOT_FOUND",
    );
    expect(base.processedRequests).toEqual([]);

    const corrected = ok(
      run(
        base,
        request("req-1", [{ favoriteId: toothpasteMint.id, quantity: 1 }]),
      ),
    );
    expect(corrected.result.replayed).toBe(false);
    expect(corrected.store.list).toHaveLength(2);
    expect(corrected.store.processedRequests).toHaveLength(1);
  });

  test("a failed request with a new item consumes no state: retrying after QUANTITY_LIMIT with a lower quantity works", () => {
    const base = makeStore({ list: [openWetWipes] });
    expectError(
      run(base, request("req-9", [{ favoriteId: wetWipes.id, quantity: 5 }])),
      "QUANTITY_LIMIT",
    );
    const retried = ok(
      run(base, request("req-9", [{ favoriteId: wetWipes.id, quantity: 1 }])),
    );
    expect(retried.store.list[0]?.quantity).toBe(99);
  });
});

describe("addToShoppingList – idempotency (SPEC §4.5)", () => {
  function firstRequest() {
    const input = request("req-1", [
      { favoriteId: wetWipes.id, quantity: 2 },
      {
        product: {
          name: "Zahnseide mint",
          dmUrl: "https://www.dm.de/beispiel-zahnseide-mint-p100007.html",
        },
        quantity: 1,
      },
    ]);
    const outcome = ok(run(makeStore(), input));
    return { input, outcome, store: deepFreeze(outcome.store) };
  }

  test("AC-A8: retrying the same requestId and items returns the original result with replayed: true", () => {
    const { input, outcome, store } = firstRequest();
    const replay = ok(run(store, input, context(T2, "unused")));

    expect(replay.result).toEqual({ ...outcome.result, replayed: true });
    expect(replay.store).toEqual(store);
  });

  test("AC-A8: a retry with a respelled dm URL and extra whitespace is still a replay", () => {
    const { outcome, store } = firstRequest();
    const respelled = request("req-1", [
      { favoriteId: wetWipes.id, quantity: 2 },
      {
        product: {
          name: "   Zahnseide mint ",
          dmUrl:
            "https://WWW.dm.de/beispiel-zahnseide-mint-p100007.html/?utm_source=newsletter#top",
        },
        quantity: 1,
      },
    ]);
    const replay = ok(run(store, respelled));
    expect(replay.result).toEqual({ ...outcome.result, replayed: true });
    expect(replay.store.list).toEqual(store.list);
  });

  test("AC-A9: the same requestId with different items fails with REQUEST_ID_CONFLICT", () => {
    const { store } = firstRequest();
    expectError(
      run(store, request("req-1", [{ favoriteId: wetWipes.id, quantity: 3 }])),
      "REQUEST_ID_CONFLICT",
    );
  });

  test("AC-A9: the same requestId with the same items in a different order fails with REQUEST_ID_CONFLICT", () => {
    const { input, store } = firstRequest();
    const reordered = deepFreeze({
      ...input,
      items: [...input.items].reverse(),
    });
    expectError(run(store, reordered), "REQUEST_ID_CONFLICT");
  });

  test("AC-A9a: a favourite changed after a successful request does not affect the replay", () => {
    const { input, outcome, store } = firstRequest();
    const changed = deepFreeze({
      ...store,
      favorites: store.favorites.map((f) =>
        f.id === wetWipes.id
          ? { ...f, name: "Feuchttücher NEU", dmArticleNumber: "200001" }
          : f,
      ),
    });
    const replay = ok(run(changed, input));
    expect(replay.result).toEqual({ ...outcome.result, replayed: true });
  });

  test("AC-A9a: a favourite deleted after a successful request does not affect the replay", () => {
    const { input, outcome, store } = firstRequest();
    const deleted = deepFreeze({
      ...store,
      favorites: store.favorites.filter((f) => f.id !== wetWipes.id),
    });
    const replay = ok(run(deleted, input));
    expect(replay.result).toEqual({ ...outcome.result, replayed: true });
    expect(replay.store).toEqual(deleted);
  });

  test("a replay returns the stored result even if the list changed in the meantime", () => {
    const { input, outcome, store } = firstRequest();
    const afterShopping = deepFreeze({
      ...store,
      list: store.list.map((e) => ({
        ...e,
        status: "bought" as const,
        boughtAt: T2,
      })),
    });
    const replay = ok(run(afterShopping, input));
    expect(replay.result).toEqual({ ...outcome.result, replayed: true });
    expect(replay.store).toEqual(afterShopping);
  });

  test("the stored result itself keeps replayed: false", () => {
    const { outcome, store } = firstRequest();
    expect(store.processedRequests[0]?.result).toEqual(outcome.result);
    expect(outcome.result.replayed).toBe(false);
  });
});
