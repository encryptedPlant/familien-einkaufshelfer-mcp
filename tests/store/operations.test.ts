import * as nodeFs from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AddContext } from "../../src/core/add-to-list";
import { payloadHash } from "../../src/core/hash";
import type { AddToShoppingListInput } from "../../src/core/types";
import { validateAddToShoppingListInput } from "../../src/core/validation";
import {
  createJsonFileStore,
  type FileSystem,
} from "../../src/store/json-file-store";
import { addToShoppingListInStore } from "../../src/store/operations";
import { toothpasteMint, wetWipes } from "../fixtures/favorites";
import { validStore } from "../fixtures/store";
import { makeTempDir, removeTempDir } from "./processes";

let dir: string;
let storePath: string;
let writes: number;

beforeEach(async () => {
  dir = await makeTempDir();
  storePath = join(dir, "store.json");
  writes = 0;
  await writeFile(storePath, JSON.stringify(validStore(), null, 2));
});
afterEach(async () => {
  await removeTempDir(dir);
});

function store() {
  const fs: Partial<FileSystem> = {
    writeFile: (p, d, o) => {
      writes++;
      return nodeFs.writeFile(p, d, o);
    },
  };
  return createJsonFileStore(storePath, { lockRetryIntervalMs: 10, fs });
}

function context(): AddContext {
  let n = 0;
  return {
    now: "2026-02-10T09:00:00.000Z",
    newId: () => `a0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
}

function request(requestId: string, items: unknown): AddToShoppingListInput {
  const result = validateAddToShoppingListInput({ requestId, items });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("addToShoppingListInStore (SPEC §4.5, R5)", () => {
  test("persists the list change and the processed request together in one write", async () => {
    const input = request("req-new", [
      { favoriteId: toothpasteMint.id, quantity: 1 },
    ]);
    const result = await addToShoppingListInStore(store(), input, context());
    expect(result).toMatchObject({ ok: true, value: { replayed: false } });
    expect(writes).toBe(1);

    const saved = JSON.parse(await readFile(storePath, "utf8"));
    expect(saved.list.map((e: { id: string }) => e.id)).toContain(
      "a0000000-0000-4000-8000-000000000001",
    );
    expect(saved.processedRequests.at(-1)).toMatchObject({
      requestId: "req-new",
      payloadHash: payloadHash(input.items),
      result: result.ok ? result.value : undefined,
    });
  });

  test("AC-A10 (storage part): a business error writes nothing and does not record the requestId", async () => {
    const before = await readFile(storePath);
    const result = await addToShoppingListInStore(
      store(),
      request("req-bad", [
        { favoriteId: wetWipes.id, quantity: 1 },
        { favoriteId: "0b1f6a52-3c4d-4e8f-9a01-ffffffffffff", quantity: 1 },
      ]),
      context(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "FAVORITE_NOT_FOUND" },
    });
    expect(writes).toBe(0);
    expect(await readFile(storePath)).toEqual(before);

    const corrected = await addToShoppingListInStore(
      store(),
      request("req-bad", [{ favoriteId: wetWipes.id, quantity: 1 }]),
      context(),
    );
    expect(corrected).toMatchObject({ ok: true, value: { replayed: false } });
    expect(writes).toBe(1);
  });

  test("AC-A11 (storage part): QUANTITY_LIMIT writes nothing", async () => {
    const before = await readFile(storePath);
    const result = await addToShoppingListInStore(
      store(),
      request("req-limit", [{ favoriteId: wetWipes.id, quantity: 98 }]),
      context(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "QUANTITY_LIMIT" },
    });
    expect(writes).toBe(0);
    expect(await readFile(storePath)).toEqual(before);
  });

  test("AC-A8 (storage part): an identical retry is answered from the store without writing", async () => {
    const input = request("req-twice", [
      { favoriteId: wetWipes.id, quantity: 3 },
    ]);
    const first = await addToShoppingListInStore(store(), input, context());
    const afterFirst = await readFile(storePath);
    const second = await addToShoppingListInStore(store(), input, context());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toEqual({ ...first.value, replayed: true });
    expect(writes).toBe(1);
    expect(await readFile(storePath)).toEqual(afterFirst);
  });

  test("AC-A9 (storage part): REQUEST_ID_CONFLICT writes nothing", async () => {
    const before = await readFile(storePath);
    const result = await addToShoppingListInStore(
      store(),
      request("req-1", [{ favoriteId: wetWipes.id, quantity: 1 }]),
      context(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REQUEST_ID_CONFLICT" },
    });
    expect(writes).toBe(0);
    expect(await readFile(storePath)).toEqual(before);
  });
});
