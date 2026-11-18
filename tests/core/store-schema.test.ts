import { describe, expect, test } from "vitest";
import { emptyStore, validateStoreFile } from "../../src/core/store-schema";
import { validStore } from "../fixtures/store";
import { deepFreeze } from "../helpers/deep-freeze";

/** A deep copy of the valid store, changed by `edit` (JSON-like, untyped). */
function variant(edit: (store: any) => void): unknown {
  const copy = structuredClone(validStore()) as any;
  edit(copy);
  return copy;
}

function expectCorrupt(data: unknown, pathPart?: string): void {
  const result = validateStoreFile(data);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("STORAGE_CORRUPT");
  if (pathPart !== undefined) expect(result.error.message).toContain(pathPart);
}

describe("validateStoreFile (SPEC §3, §4.6)", () => {
  test("accepts the empty store", () => {
    expect(validateStoreFile(emptyStore())).toEqual({
      ok: true,
      value: emptyStore(),
    });
  });

  test("accepts a complete valid store with open and bought entries and processed requests", () => {
    const store = deepFreeze(validStore());
    expect(validateStoreFile(store)).toEqual({ ok: true, value: validStore() });
  });

  test.each([
    ["not an object", "[]"],
    ["null", null],
    ["missing version", variant((s) => delete s.version)],
    ["unknown version 2", variant((s) => (s.version = 2))],
    ["missing list", variant((s) => delete s.list)],
    ["an unknown top-level key", variant((s) => (s.extra = true))],
  ])("AC-A15 / AC-L4 (content part): rejects %s", (_label, data) => {
    expectCorrupt(data);
  });

  test("names the unsupported version in the message", () => {
    expectCorrupt(
      variant((s) => (s.version = 2)),
      "version",
    );
  });

  test.each([
    [
      "an untrimmed favourite name",
      (s: any) => (s.favorites[0].name = " Spüli"),
    ],
    [
      "a favourite without category",
      (s: any) => delete s.favorites[0].category,
    ],
    ["a non-UUID favourite id", (s: any) => (s.favorites[0].id = "fav-1")],
    ["a non-normalised dm URL", (s: any) => (s.favorites[0].dmUrl += "?x=1")],
    [
      "a dm URL longer than 2048 characters",
      (s: any) =>
        (s.favorites[0].dmUrl = "https://www.dm.de/p" + "a".repeat(2030)),
    ],
    [
      "the dm start page as URL",
      (s: any) => (s.favorites[0].dmUrl = "https://www.dm.de"),
    ],
    [
      "a non-digit article number",
      (s: any) => (s.favorites[0].dmArticleNumber = "10A"),
    ],
    ["a whitespace-only alias", (s: any) => (s.favorites[0].aliases = ["   "])],
    [
      "21 aliases",
      (s: any) =>
        (s.favorites[0].aliases = Array.from(
          { length: 21 },
          (_, i) => `Alias ${i}`,
        )),
    ],
    ["a quantity of 0", (s: any) => (s.list[0].quantity = 0)],
    ["a quantity of 100", (s: any) => (s.list[0].quantity = 100)],
    ["an unknown status", (s: any) => (s.list[0].status = "deleted")],
    ["a bought entry without boughtAt", (s: any) => delete s.list[1].boughtAt],
    [
      "an open entry with boughtAt",
      (s: any) => (s.list[0].boughtAt = "2026-02-03T17:45:00.000Z"),
    ],
    [
      "a non-UTC timestamp",
      (s: any) => (s.list[0].addedAt = "2026-02-01T10:00:00+01:00"),
    ],
    [
      "a payload hash that is not 64 hex characters",
      (s: any) => (s.processedRequests[0].payloadHash = "abc"),
    ],
    [
      "a stored result with replayed: true",
      (s: any) => (s.processedRequests[0].result.replayed = true),
    ],
    [
      "a stored result for another requestId",
      (s: any) => (s.processedRequests[0].result.requestId = "req-2"),
    ],
    [
      "an invalid requestId",
      (s: any) => (s.processedRequests[0].requestId = "req 1"),
    ],
  ])("rejects %s", (_label, edit) => {
    expectCorrupt(variant(edit));
  });

  test.each([
    [
      "the same alias on two favourites (after normalisation)",
      (s: any) => (s.favorites[1].aliases = ["  SPÜLI".trim()]),
    ],
    [
      "the same alias twice on one favourite (after normalisation)",
      (s: any) => (s.favorites[2].aliases = ["Spüli", "spüli"]),
    ],
    [
      "a duplicate favourite id",
      (s: any) => (s.favorites[1].id = s.favorites[0].id),
    ],
    ["a duplicate list entry id", (s: any) => (s.list[1].id = s.list[0].id)],
    [
      "a duplicate processed requestId",
      (s: any) =>
        s.processedRequests.push(structuredClone(s.processedRequests[0])),
    ],
  ])("consistency: rejects %s", (_label, edit) => {
    expectCorrupt(variant(edit));
  });

  test("allows duplicate favourite names (AC-S3) and entries referring to unknown favourites", () => {
    const data = variant((s) => {
      s.favorites[1].name = s.favorites[0].name;
      s.list[0].favoriteId = "0b1f6a52-3c4d-4e8f-9a01-999999999999";
    });
    expect(validateStoreFile(data).ok).toBe(true);
  });
});
