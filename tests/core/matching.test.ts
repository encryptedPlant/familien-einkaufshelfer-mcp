import { describe, expect, test } from "vitest";
import { resolveItems } from "../../src/core/matching";
import type { Favorite, ResolveItemsInput } from "../../src/core/types";
import { validateResolveItemsInput } from "../../src/core/validation";
import {
  dishSoap,
  favorites,
  showerGelPlain,
  showerGelSea,
  toothpasteHerbal,
  toothpasteMint,
  wetWipes,
} from "../fixtures/favorites";
import { deepFreeze } from "../helpers/deep-freeze";

function resolveOne(
  term: string,
  quantity = 1,
  favs: readonly Favorite[] = favorites,
) {
  const result = resolveItems({ items: [{ term, quantity }] }, favs).results[0];
  if (!result) throw new Error("expected one result");
  return result;
}

describe("resolveItems (SPEC §4.3, §6.1)", () => {
  test("AC-R1: an alias with different case and extra whitespace resolves with the given quantity", () => {
    const validated = validateResolveItemsInput({
      items: [{ term: "  Die üblichen  FEUCHTTÜCHER ", quantity: 2 }],
    });
    if (!validated.ok) throw new Error(validated.error.message);
    expect(resolveItems(validated.value, favorites).results).toEqual([
      {
        term: "Die üblichen  FEUCHTTÜCHER",
        quantity: 2,
        status: "resolved",
        favorite: wetWipes,
      },
    ]);
  });

  test("AC-R2: alias of one favourite beats the name of another", () => {
    expect(resolveOne("Duschgel")).toEqual({
      term: "Duschgel",
      quantity: 1,
      status: "resolved",
      favorite: showerGelSea,
    });
    expect(showerGelPlain.name).toBe("Duschgel");
  });

  test("AC-R3: a term matching the names of two favourites is ambiguous and lists both", () => {
    expect(resolveOne("zahnpasta")).toEqual({
      term: "zahnpasta",
      quantity: 1,
      status: "ambiguous",
      candidates: [toothpasteMint, toothpasteHerbal],
    });
  });

  test("AC-R4: a category shared by two favourites is ambiguous", () => {
    const favs = [wetWipes, toothpasteMint, toothpasteHerbal, dishSoap];
    expect(resolveOne("ZAHNPFLEGE", 1, favs)).toEqual({
      term: "ZAHNPFLEGE",
      quantity: 1,
      status: "ambiguous",
      candidates: [toothpasteMint, toothpasteHerbal],
    });
  });

  test("AC-R4: a category with exactly one favourite resolves to it", () => {
    expect(resolveOne("Haushalt", 3)).toEqual({
      term: "Haushalt",
      quantity: 3,
      status: "resolved",
      favorite: dishSoap,
    });
  });

  test("AC-R5: a term without any hit is unknown", () => {
    expect(resolveOne("Sonnencreme")).toEqual({
      term: "Sonnencreme",
      quantity: 1,
      status: "unknown",
    });
  });

  test("AC-R5: a substring of an alias is unknown", () => {
    expect(resolveOne("feucht")).toEqual({
      term: "feucht",
      quantity: 1,
      status: "unknown",
    });
  });

  test("a name match beats a category match", () => {
    // "Feuchttücher sensitiv" is wetWipes' name; another favourite has it as category.
    const sensitiveCategory: Favorite = {
      ...dishSoap,
      id: "0b1f6a52-3c4d-4e8f-9a01-777777777777",
      name: "Pflegetücher",
      category: "Feuchttücher sensitiv",
      aliases: [],
    };
    expect(
      resolveOne("feuchttücher sensitiv", 1, [sensitiveCategory, wetWipes]),
    ).toMatchObject({
      status: "resolved",
      favorite: wetWipes,
    });
  });

  test("does no fuzzy matching: umlaut spelling and plural variants are unknown", () => {
    expect(resolveOne("Spuelmittel Zitrone").status).toBe("unknown");
    expect(resolveOne("Feuchttuch sensitiv").status).toBe("unknown");
  });

  test("never picks one of several alias hits, even in inconsistent data", () => {
    const duplicateAlias: Favorite = {
      ...dishSoap,
      id: "0b1f6a52-3c4d-4e8f-9a01-888888888888",
      aliases: ["SPÜLI"],
    };
    expect(resolveOne("Spüli", 1, [dishSoap, duplicateAlias])).toEqual({
      term: "Spüli",
      quantity: 1,
      status: "ambiguous",
      candidates: [dishSoap, duplicateAlias],
    });
  });

  test("returns one result per item in input order", () => {
    const input: ResolveItemsInput = {
      items: [
        { term: "Sonnencreme", quantity: 1 },
        { term: "Spüli", quantity: 2 },
        { term: "Zahnpasta", quantity: 1 },
      ],
    };
    expect(
      resolveItems(input, favorites).results.map((r) => [r.term, r.status]),
    ).toEqual([
      ["Sonnencreme", "unknown"],
      ["Spüli", "resolved"],
      ["Zahnpasta", "ambiguous"],
    ]);
  });

  test("returns unknown for every term when there are no favourites", () => {
    expect(resolveOne("Spüli", 1, []).status).toBe("unknown");
  });

  test("AC-R6 (pure part): neither the input nor the favourites are modified", () => {
    const frozenFavorites = deepFreeze(structuredClone(favorites));
    const input = deepFreeze({ items: [{ term: "Zahnpasta", quantity: 1 }] });
    resolveItems(input, frozenFavorites);
    expect(frozenFavorites).toEqual(favorites);
    expect(input).toEqual({ items: [{ term: "Zahnpasta", quantity: 1 }] });
  });
});
