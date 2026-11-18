import { describe, expect, test } from "vitest";
import type { Result } from "../../src/core/errors";
import {
  saveFavorite,
  type SaveFavoriteContext,
} from "../../src/core/favorites";
import { emptyStore } from "../../src/core/store-schema";
import type { SaveFavoriteInput, StoreFile } from "../../src/core/types";
import { validateSaveFavoriteInput } from "../../src/core/validation";
import { dishSoap, toothpasteMint, wetWipes } from "../fixtures/favorites";
import { deepFreeze } from "../helpers/deep-freeze";

const NOW = "2026-03-01T09:30:00.000Z";
const NEW_ID = "f0000000-0000-4000-8000-000000000001";
const context = (): SaveFavoriteContext => ({ now: NOW, newId: () => NEW_ID });

function valid(raw: unknown): SaveFavoriteInput {
  const result = validateSaveFavoriteInput(raw);
  if (!result.ok) throw new Error(result.error.message);
  return deepFreeze(result.value);
}

function expectError(result: Result<unknown>, code: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected an error");
  expect(result.error.code).toBe(code);
  expect(result).not.toHaveProperty("value");
  return result.error;
}

const store = (): StoreFile =>
  deepFreeze({
    ...emptyStore(),
    favorites: structuredClone([wetWipes, toothpasteMint, dishSoap]),
  });

describe("validateSaveFavoriteInput (SPEC §6.6)", () => {
  test("rejects a dm URL longer than 2048 characters", () => {
    const dmUrl = "https://www.dm.de/p" + "a".repeat(2030);
    expect(dmUrl).toHaveLength(2049);
    expectError(
      validateSaveFavoriteInput({
        name: "Handcreme Mandel",
        category: "Körperpflege",
        dmUrl,
      }),
      "VALIDATION_ERROR",
    );
  });

  test("trims text, defaults aliases to [] and normalises the dm URL", () => {
    expect(
      validateSaveFavoriteInput({
        name: "  Handcreme Mandel ",
        category: " Körperpflege ",
        dmUrl:
          "https://DM.de/beispiel-handcreme-mandel-p900100.html/?utm=x#top",
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Handcreme Mandel",
        category: "Körperpflege",
        aliases: [],
        dmUrl: "https://www.dm.de/beispiel-handcreme-mandel-p900100.html",
      },
    });
  });

  test("trims aliases and keeps an article number", () => {
    expect(
      validateSaveFavoriteInput({
        name: "Handcreme Mandel",
        category: "Körperpflege",
        aliases: ["  die übliche Handcreme "],
        dmArticleNumber: " 900100 ",
      }),
    ).toMatchObject({
      ok: true,
      value: { aliases: ["die übliche Handcreme"], dmArticleNumber: "900100" },
    });
  });

  test("accepts a favourite without dm identifiers (SPEC §6.6, AC-A6)", () => {
    expect(
      validateSaveFavoriteInput({ name: "Teelichter", category: "Haushalt" })
        .ok,
    ).toBe(true);
  });

  test.each([
    ["a whitespace-only name", { name: "   ", category: "Haushalt" }],
    ["a whitespace-only category", { name: "Teelichter", category: " \t " }],
    [
      "a whitespace-only alias",
      { name: "Teelichter", category: "Haushalt", aliases: ["  "] },
    ],
  ])("AC-S4: %s is a VALIDATION_ERROR", (_label, raw) => {
    expectError(validateSaveFavoriteInput(raw), "VALIDATION_ERROR");
  });

  test.each([
    ["a missing category", { name: "Teelichter" }],
    ["a missing name", { category: "Haushalt" }],
    [
      "21 aliases",
      {
        name: "Teelichter",
        category: "Haushalt",
        aliases: Array.from({ length: 21 }, (_, i) => `Kerzen ${i}`),
      },
    ],
    [
      "an alias of 101 characters",
      { name: "Teelichter", category: "Haushalt", aliases: ["a".repeat(101)] },
    ],
    [
      "a name of 201 characters",
      { name: "a".repeat(201), category: "Haushalt" },
    ],
    [
      "a non-digit article number",
      { name: "Teelichter", category: "Haushalt", dmArticleNumber: "90A100" },
    ],
    [
      "a non-dm URL",
      {
        name: "Teelichter",
        category: "Haushalt",
        dmUrl: "https://www.example.com/teelichter.html",
      },
    ],
    [
      "the dm start page",
      { name: "Teelichter", category: "Haushalt", dmUrl: "https://www.dm.de/" },
    ],
    [
      "the dm start page with query",
      {
        name: "Teelichter",
        category: "Haushalt",
        dmUrl: "https://dm.de/?ref=app",
      },
    ],
    [
      "an unknown field",
      { name: "Teelichter", category: "Haushalt", gtin: "4000000000000" },
    ],
    ["no object", "Teelichter"],
  ])("rejects %s with VALIDATION_ERROR", (_label, raw) => {
    expectError(validateSaveFavoriteInput(raw), "VALIDATION_ERROR");
  });
});

describe("saveFavorite (SPEC §6.6)", () => {
  test("AC-S1: a valid favourite is stored with a new id and createdAt and returned", () => {
    const before = store();
    const input = valid({
      name: "Handcreme Mandel",
      category: "Körperpflege",
      aliases: ["die übliche Handcreme"],
      dmArticleNumber: "900100",
    });
    const result = saveFavorite(before, input, context());
    if (!result.ok) throw new Error(result.error.message);

    const expected = {
      id: NEW_ID,
      name: "Handcreme Mandel",
      category: "Körperpflege",
      aliases: ["die übliche Handcreme"],
      dmArticleNumber: "900100",
      createdAt: NOW,
    };
    expect(result.value.favorite).toEqual(expected);
    expect(result.value.store.favorites).toEqual([
      ...before.favorites,
      expected,
    ]);
    expect(result.value.store.list).toBe(before.list);
    expect(before.favorites).toHaveLength(3);
  });

  test("AC-S2: an alias colliding with an existing alias after normalisation is DUPLICATE_ALIAS", () => {
    const error = expectError(
      saveFavorite(
        store(),
        valid({
          name: "Spülmittel Lavendel",
          category: "Haushalt",
          aliases: ["  SPÜLI "],
        }),
        context(),
      ),
      "DUPLICATE_ALIAS",
    );
    expect(error.details).toMatchObject({
      alias: "SPÜLI",
      favoriteId: dishSoap.id,
    });
  });

  test("AC-S2: two aliases of the same input colliding after normalisation are DUPLICATE_ALIAS", () => {
    const error = expectError(
      saveFavorite(
        store(),
        valid({
          name: "Handcreme Mandel",
          category: "Körperpflege",
          aliases: ["Die übliche  Handcreme", "die übliche handcreme"],
        }),
        context(),
      ),
      "DUPLICATE_ALIAS",
    );
    expect(error.details).toMatchObject({ alias: "die übliche handcreme" });
  });

  test("AC-S3: duplicate names are allowed", () => {
    const result = saveFavorite(
      store(),
      valid({ name: wetWipes.name, category: wetWipes.category }),
      context(),
    );
    expect(result.ok).toBe(true);
  });

  test("an alias equal to another favourite's name or category is not a conflict", () => {
    const result = saveFavorite(
      store(),
      valid({
        name: "Zahnseide",
        category: "Zahnpflege",
        aliases: ["Zahnpflege", "Spülmittel Zitrone"],
      }),
      context(),
    );
    expect(result.ok).toBe(true);
  });

  test("calls newId once and leaves the given store and input unchanged", () => {
    let calls = 0;
    const before = store();
    const snapshot = structuredClone(before);
    const input = valid({ name: "Teelichter", category: "Haushalt" });
    saveFavorite(before, input, { now: NOW, newId: () => (calls++, NEW_ID) });
    expect(calls).toBe(1);
    expect(before).toEqual(snapshot);
  });
});
