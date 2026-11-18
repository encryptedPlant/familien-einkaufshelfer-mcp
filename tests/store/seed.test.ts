import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { emptyStore, validateStoreFile } from "../../src/core/store-schema";
import type { Favorite } from "../../src/core/types";
import { createJsonFileStore } from "../../src/store/json-file-store";
import { seedFavorites } from "../../src/store/seed";
import { validStore } from "../fixtures/store";
import {
  killAllWorkers,
  makeTempDir,
  removeTempDir,
  ROOT,
  spawnTs,
  startWorker,
} from "./processes";

const SAMPLE_FILE = join(ROOT, "data", "sample-favorites.json");

let dir: string;
let storePath: string;

beforeEach(async () => {
  dir = await makeTempDir();
  storePath = join(dir, "store.json");
});
afterEach(async () => {
  await killAllWorkers();
  await removeTempDir(dir);
});

async function samples(): Promise<Favorite[]> {
  return JSON.parse(await readFile(SAMPLE_FILE, "utf8")) as Favorite[];
}

const store = () => createJsonFileStore(storePath, { lockRetryIntervalMs: 10 });

describe("sample favourites (SPEC §4.6)", () => {
  test("data/sample-favorites.json is a valid, fictional favourites list with unique aliases", async () => {
    const favorites = await samples();
    expect(favorites.length).toBeGreaterThan(0);
    expect(validateStoreFile({ ...emptyStore(), favorites }).ok).toBe(true);
    for (const f of favorites) {
      if (f.dmUrl !== undefined)
        expect(f.dmUrl).toMatch(/^https:\/\/www\.dm\.de\/beispiel-/);
    }
  });
});

describe("seedFavorites (SPEC §4.6)", () => {
  test("fills a missing store", async () => {
    const favorites = await samples();
    expect(await seedFavorites(store(), favorites)).toEqual({
      ok: true,
      value: { status: "seeded", count: favorites.length },
    });
    expect(await store().read()).toEqual({
      ok: true,
      value: { ...emptyStore(), favorites },
    });
  });

  test("fills an existing empty store", async () => {
    await writeFile(storePath, JSON.stringify(emptyStore()));
    const result = await seedFavorites(store(), await samples());
    expect(result).toMatchObject({ ok: true, value: { status: "seeded" } });
  });

  test.each([
    ["favourites", { ...emptyStore(), favorites: validStore().favorites }],
    ["list entries", { ...emptyStore(), list: validStore().list }],
    ["processed requests", { ...validStore(), favorites: [], list: [] }],
  ])("never overwrites a store with %s", async (_label, existing) => {
    await writeFile(storePath, JSON.stringify(existing));
    const before = await readFile(storePath);
    expect(await seedFavorites(store(), await samples())).toEqual({
      ok: true,
      value: { status: "not-empty" },
    });
    expect(await readFile(storePath)).toEqual(before);
  });

  test("rejects invalid favourites without writing", async () => {
    const favorites = await samples();
    const duplicateAlias = favorites.map((f, i) =>
      i === 1 ? { ...f, aliases: [...(favorites[0]?.aliases ?? [])] } : f,
    );
    expect(await seedFavorites(store(), duplicateAlias)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(existsSync(storePath)).toBe(false);
  });

  test("a corrupt store is reported and left unchanged", async () => {
    await writeFile(storePath, "{ broken");
    expect(await seedFavorites(store(), await samples())).toMatchObject({
      ok: false,
      error: { code: "STORAGE_CORRUPT" },
    });
    expect(await readFile(storePath, "utf8")).toBe("{ broken");
  });

  test("uses the store lock: while another process holds it, seeding fails with STORAGE_UNAVAILABLE", async () => {
    const holder = startWorker({ type: "hold-lock", storePath });
    await holder.next("locked");
    const result = await seedFavorites(
      createJsonFileStore(storePath, {
        lockTimeoutMs: 300,
        lockRetryIntervalMs: 50,
      }),
      await samples(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE" },
    });
    expect(existsSync(storePath)).toBe(false);
    holder.send("release");
    await holder.next("released");
  }, 30_000);
});

describe("npm run seed (scripts/seed.ts)", () => {
  function runSeed(): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }> {
    const child = spawnTs(join(ROOT, "scripts", "seed.ts"), [], {
      cwd: dir,
      env: { EINKAUFSHELFER_DATA_FILE: storePath },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += String(c)));
    child.stderr?.on("data", (c) => (stderr += String(c)));
    return new Promise((res) =>
      child.on("exit", (code) => res({ code, stdout, stderr })),
    );
  }

  test("seeds the store named by EINKAUFSHELFER_DATA_FILE once and refuses a second time", async () => {
    const first = await runSeed();
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(storePath);
    const afterFirst = await readFile(storePath);
    expect(JSON.parse(String(afterFirst)).favorites).toEqual(await samples());

    const second = await runSeed();
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("not empty");
    expect(await readFile(storePath)).toEqual(afterFirst);
  }, 30_000);
});
