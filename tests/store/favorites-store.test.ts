import * as nodeFs from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SaveFavoriteContext } from "../../src/core/favorites";
import { emptyStore } from "../../src/core/store-schema";
import type { SaveFavoriteInput, StoreFile } from "../../src/core/types";
import { validateSaveFavoriteInput } from "../../src/core/validation";
import {
  createJsonFileStore,
  type FileSystem,
} from "../../src/store/json-file-store";
import { saveFavoriteInStore } from "../../src/store/operations";
import { dishSoap, wetWipes } from "../fixtures/favorites";
import {
  killAllWorkers,
  makeTempDir,
  removeTempDir,
  startWorker,
} from "./processes";

let dir: string;
let storePath: string;
let writes: number;

beforeEach(async () => {
  dir = await makeTempDir();
  storePath = join(dir, "store.json");
  writes = 0;
});
afterEach(async () => {
  await killAllWorkers();
  await removeTempDir(dir);
});

const context = (): SaveFavoriteContext => ({
  now: "2026-03-01T09:30:00.000Z",
  newId: () => "f0000000-0000-4000-8000-000000000001",
});

function input(raw: unknown): SaveFavoriteInput {
  const result = validateSaveFavoriteInput(raw);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function store(fs: Partial<FileSystem> = {}) {
  return createJsonFileStore(storePath, {
    lockRetryIntervalMs: 10,
    log: () => {},
    fs: {
      writeFile: (p, d, o) => {
        writes++;
        return (fs.writeFile ?? nodeFs.writeFile)(p, d, o);
      },
    },
  });
}

async function writeStore(state: StoreFile): Promise<Buffer> {
  await writeFile(storePath, JSON.stringify(state, null, 2));
  return readFile(storePath);
}

describe("saveFavoriteInStore (SPEC §6.6)", () => {
  test("AC-S1 (storage part): the favourite is written and can be read back", async () => {
    const result = await saveFavoriteInStore(
      store(),
      input({ name: "Teelichter", category: "Haushalt", aliases: ["Kerzen"] }),
      context(),
    );
    expect(result).toMatchObject({ ok: true, value: { name: "Teelichter" } });
    expect(writes).toBe(1);
    const saved = JSON.parse(await readFile(storePath, "utf8")) as StoreFile;
    expect(saved.favorites.map((f) => f.name)).toEqual(["Teelichter"]);
  });

  test("AC-S2 (storage part): an alias conflict writes nothing", async () => {
    const before = await writeStore({
      ...emptyStore(),
      favorites: [wetWipes, dishSoap],
    });
    const result = await saveFavoriteInStore(
      store(),
      input({
        name: "Spülmittel Lavendel",
        category: "Haushalt",
        aliases: ["spüli"],
      }),
      context(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_ALIAS" },
    });
    expect(writes).toBe(0);
    expect(await readFile(storePath)).toEqual(before);
  });

  test("a failing write is STORAGE_UNAVAILABLE without a success message; the file is unchanged", async () => {
    const before = await writeStore({ ...emptyStore(), favorites: [wetWipes] });
    const result = await saveFavoriteInStore(
      store({
        writeFile: () =>
          Promise.reject(
            Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" }),
          ),
      }),
      input({ name: "Teelichter", category: "Haushalt" }),
      context(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE" },
    });
    expect(await readFile(storePath)).toEqual(before);
  });
});

describe("save_favorite with separate OS processes (SPEC §6.6, §4.6)", () => {
  test("two processes saving the same alias concurrently: at most one succeeds", async () => {
    await writeStore({ ...emptyStore(), favorites: [wetWipes] });
    const worker = (prefix: string, name: string) =>
      startWorker({
        type: "save-favorite",
        storePath,
        favorite: {
          name,
          category: "Haushalt",
          aliases: ["die üblichen Kerzen"],
        },
        idPrefix: prefix,
        now: "2026-03-01T09:30:00.000Z",
        waitForGo: true,
        options: { lockRetryIntervalMs: 10 },
      });
    const a = worker("aaaaaaaa", "Teelichter weiß");
    const b = worker("bbbbbbbb", "Teelichter rot");
    await Promise.all([a.next("ready"), b.next("ready")]);
    a.send("go");
    b.send("go");
    const [ra, rb] = await Promise.all([a.next("done"), b.next("done")]);

    const results = [ra.result, rb.result] as {
      ok: boolean;
      error?: { code: string };
    }[];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => r.error?.code)).toEqual([
      "DUPLICATE_ALIAS",
    ]);
    const saved = JSON.parse(await readFile(storePath, "utf8")) as StoreFile;
    expect(
      saved.favorites.filter((f) => f.aliases.includes("die üblichen Kerzen")),
    ).toHaveLength(1);
    expect(saved.favorites).toHaveLength(2);
  }, 30_000);
});
