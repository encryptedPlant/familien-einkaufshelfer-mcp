import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { canonicalJson, payloadHash } from "../../src/core/hash";
import type { AddItem } from "../../src/core/types";
import { validateAddToShoppingListInput } from "../../src/core/validation";
import { deepFreeze } from "../helpers/deep-freeze";

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function validatedItems(items: unknown): readonly AddItem[] {
  const result = validateAddToShoppingListInput({ requestId: "req-1", items });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.items;
}

describe("canonicalJson (SPEC §4.5)", () => {
  test("sorts object keys recursively and keeps array order", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [3, { f: 1, e: "x" }], c: "ü" } }),
    ).toBe('{"a":{"c":"ü","d":[3,{"e":"x","f":1}]},"b":1}');
  });

  test("does not depend on the key order of the given objects", () => {
    expect(canonicalJson({ quantity: 2, favoriteId: "f-1" })).toBe(
      canonicalJson({ favoriteId: "f-1", quantity: 2 }),
    );
  });

  test("does not modify the given value", () => {
    const value = deepFreeze({ b: [{ d: 1, c: 2 }], a: "x" });
    canonicalJson(value);
    expect(value).toEqual({ b: [{ d: 1, c: 2 }], a: "x" });
  });
});

describe("payloadHash (SPEC §4.5)", () => {
  const items = validatedItems([
    { favoriteId: "0b1f6a52-3c4d-4e8f-9a01-111111111111", quantity: 2 },
    {
      product: {
        name: "Zahnseide mint",
        dmUrl: "https://www.dm.de/beispiel-zahnseide-mint-p100007.html",
      },
      quantity: 1,
    },
  ]);

  test("is the SHA-256 hex digest of the canonical JSON of the items", () => {
    expect(payloadHash(items)).toBe(sha256(canonicalJson(items)));
    expect(payloadHash(items)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("AC-A8 (hash part): equivalent spellings validate to the same hash", () => {
    const respelled = validatedItems([
      { quantity: 2, favoriteId: "0b1f6a52-3c4d-4e8f-9a01-111111111111" },
      {
        quantity: 1,
        product: {
          dmUrl:
            "https://DM.de/beispiel-zahnseide-mint-p100007.html/?utm_source=x#top",
          name: "  Zahnseide mint ",
        },
      },
    ]);
    expect(payloadHash(respelled)).toBe(payloadHash(items));
  });

  test("AC-A9 (hash part): the same items in a different order hash differently", () => {
    expect(payloadHash([...items].reverse())).not.toBe(payloadHash(items));
  });

  test("a different quantity or favourite id hashes differently", () => {
    const [first, second] = items;
    if (!first || !second || !("favoriteId" in first))
      throw new Error("fixture");
    expect(payloadHash([{ ...first, quantity: 3 }, second])).not.toBe(
      payloadHash(items),
    );
    expect(
      payloadHash([{ ...first, favoriteId: "other-favorite" }, second]),
    ).not.toBe(payloadHash(items));
  });

  test("hashes a favourite id as given, without any favourite data", () => {
    const viaFavorite: AddItem[] = [{ favoriteId: "f-1", quantity: 1 }];
    expect(payloadHash(viaFavorite)).toBe(
      sha256('[{"favoriteId":"f-1","quantity":1}]'),
    );
  });
});
