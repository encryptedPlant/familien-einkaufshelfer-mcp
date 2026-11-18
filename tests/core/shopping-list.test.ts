import { describe, expect, test } from "vitest";
import { openEntries } from "../../src/core/shopping-list";
import type { ListEntry } from "../../src/core/types";
import { deepFreeze } from "../helpers/deep-freeze";

const entry = (
  id: string,
  addedAt: string,
  status: ListEntry["status"] = "open",
): ListEntry => ({
  id,
  product: {
    name: `Produkt ${id}`,
    dmArticleNumber: id.replace(/\D/g, "") || "1",
  },
  quantity: 1,
  status,
  addedAt,
  ...(status === "bought" ? { boughtAt: "2026-03-01T00:00:00.000Z" } : {}),
});

describe("openEntries (SPEC §6.3)", () => {
  test("AC-L1/AC-L2 (core part): only open entries, ordered by addedAt ascending", () => {
    const list = deepFreeze([
      entry("e3", "2026-02-03T08:00:00.000Z"),
      entry("e1", "2026-02-01T08:00:00.000Z"),
      entry("e9", "2026-01-15T08:00:00.000Z", "bought"),
      entry("e2", "2026-02-02T08:00:00.000Z"),
    ]);
    expect(openEntries(list).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  test("compares timestamps as times, not as text", () => {
    const list = [
      entry("e2", "2026-02-01T08:00:00.5Z"),
      entry("e1", "2026-02-01T08:00:00Z"),
    ];
    expect(openEntries(list).map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  test("keeps the store order for equal timestamps and does not modify the list", () => {
    const list = deepFreeze([
      entry("e1", "2026-02-01T08:00:00.000Z"),
      entry("e2", "2026-02-01T08:00:00.000Z"),
    ]);
    const before = structuredClone(list);
    expect(openEntries(list).map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(list).toEqual(before);
  });

  test("returns an empty list when nothing is open", () => {
    expect(
      openEntries([entry("e1", "2026-02-01T08:00:00.000Z", "bought")]),
    ).toEqual([]);
  });
});
