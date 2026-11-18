import * as nodeFs from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { emptyStore } from "../../src/core/store-schema";
import type { StoreFile } from "../../src/core/types";
import {
  createJsonFileStore,
  type FileSystem,
  type JsonFileStoreOptions,
} from "../../src/store/json-file-store";
import { validStore } from "../fixtures/store";
import { makeTempDir, removeTempDir } from "./processes";

let dir: string;
let storePath: string;
let logs: string[];

beforeEach(async () => {
  dir = await makeTempDir();
  storePath = join(dir, "store.json");
  logs = [];
});
afterEach(async () => {
  await removeTempDir(dir);
});

/** Short timings for in-process tests; library minimums are kept. */
function options(extra: JsonFileStoreOptions = {}): JsonFileStoreOptions {
  return {
    lockTimeoutMs: 1000,
    lockRetryIntervalMs: 10,
    renameTimeoutMs: 300,
    renameRetryIntervalMs: 10,
    log: (message) => logs.push(message),
    ...extra,
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

/** Real file system with call recording and optional overrides. */
function recordingFs(overrides: Partial<FileSystem> = {}) {
  const calls: { op: string; path: string }[] = [];
  const real: FileSystem = {
    readFile: (p, e) => nodeFs.readFile(p, e),
    writeFile: (p, d, o) => nodeFs.writeFile(p, d, o),
    rename: (a, b) => nodeFs.rename(a, b),
    unlink: (p) => nodeFs.unlink(p),
    mkdir: (p, o) => nodeFs.mkdir(p, o),
  };
  const fs: FileSystem = {
    readFile: (p, e) => (
      calls.push({ op: "readFile", path: p }),
      (overrides.readFile ?? real.readFile)(p, e)
    ),
    writeFile: (p, d, o) => (
      calls.push({ op: "writeFile", path: p }),
      (overrides.writeFile ?? real.writeFile)(p, d, o)
    ),
    rename: (a, b) => (
      calls.push({ op: "rename", path: a }),
      (overrides.rename ?? real.rename)(a, b)
    ),
    unlink: (p) => (
      calls.push({ op: "unlink", path: p }),
      (overrides.unlink ?? real.unlink)(p)
    ),
    mkdir: (p, o) => (
      calls.push({ op: "mkdir", path: p }),
      (overrides.mkdir ?? real.mkdir)(p, o)
    ),
  };
  return {
    fs,
    calls,
    count: (op: string) => calls.filter((c) => c.op === op).length,
  };
}

async function writeStoreFile(content: StoreFile | string): Promise<Buffer> {
  await writeFile(
    storePath,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
  return readFile(storePath);
}

const leftoverTempFiles = async () =>
  (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
const lockExists = () => existsSync(`${storePath}.lock`);

/** Update function that adds one favourite-free open entry. */
function addEntry(current: StoreFile) {
  const next: StoreFile = {
    ...current,
    list: [
      ...current.list,
      {
        id: "f0000000-0000-4000-8000-000000000001",
        product: { name: "Handcreme", dmArticleNumber: "100123" },
        quantity: 1,
        status: "open",
        addedAt: "2026-02-05T08:00:00.000Z",
      },
    ],
  };
  return { ok: true as const, value: "written", next };
}

describe("read() (SPEC §4.6)", () => {
  test("AC-L3 (storage part): a missing file reads as the empty store and nothing is created", async () => {
    const nested = join(dir, "not-yet", "store.json");
    const store = createJsonFileStore(nested, options());
    expect(await store.read()).toEqual({ ok: true, value: emptyStore() });
    expect(existsSync(join(dir, "not-yet"))).toBe(false);
  });

  test("returns the validated content of an existing file", async () => {
    await writeStoreFile(validStore());
    expect(await createJsonFileStore(storePath, options()).read()).toEqual({
      ok: true,
      value: validStore(),
    });
  });

  test.each([
    ["invalid JSON", "{ not json"],
    [
      "a schema violation",
      JSON.stringify({ ...validStore(), list: [{ id: 1 }] }),
    ],
    ["an unknown version", JSON.stringify({ ...validStore(), version: 2 })],
  ])(
    "AC-L4 / AC-A15: %s is STORAGE_CORRUPT and the file stays byte-for-byte unchanged",
    async (_label, content) => {
      const before = await writeStoreFile(content);
      const result = await createJsonFileStore(storePath, options()).read();
      expect(result).toMatchObject({
        ok: false,
        error: { code: "STORAGE_CORRUPT" },
      });
      expect(await readFile(storePath)).toEqual(before);
    },
  );

  test("AC-L4: an unreadable store (the path is a directory) is STORAGE_UNAVAILABLE", async () => {
    await mkdir(storePath);
    const result = await createJsonFileStore(storePath, options()).read();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE" },
    });
  });

  test("AC-L4: a permission error while reading is STORAGE_UNAVAILABLE", async () => {
    await writeStoreFile(validStore());
    const { fs } = recordingFs({
      readFile: () => Promise.reject(errno("EACCES")),
    });
    const result = await createJsonFileStore(storePath, options({ fs })).read();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", details: { cause: "EACCES" } },
    });
  });

  test.each([
    [
      "unreadable store",
      "STORAGE_UNAVAILABLE",
      () => recordingFs({ readFile: () => Promise.reject(errno("EACCES")) }).fs,
      "{}",
    ],
    ["invalid JSON", "STORAGE_CORRUPT", () => undefined, '"Geheimprodukt'],
    [
      "schema violation",
      "STORAGE_CORRUPT",
      () => undefined,
      JSON.stringify({ ...validStore(), list: [{ id: 1 }] }),
    ],
  ])(
    "%s: the client error names neither the store path nor OS or parser text; the log has the detail",
    async (_label, code, makeFs, content) => {
      await writeStoreFile(content);
      const fs = makeFs();
      const store = createJsonFileStore(
        storePath,
        options(fs !== undefined ? { fs } : {}),
      );
      const result = await store.read();
      expect(result).toMatchObject({ ok: false, error: { code } });
      const visible = JSON.stringify(result);
      expect(visible).not.toContain(dir);
      expect(visible).not.toContain(JSON.stringify(dir).slice(1, -1));
      expect(visible).not.toContain("simulated");
      expect(visible).not.toContain("Geheimprodukt");
      expect(logs.some((m) => m.includes(storePath))).toBe(true);
    },
  );
});

describe("STORAGE_CORRUPT never returns store content to the client", () => {
  const MARKER = "VERTRAULICH-7f3a9c";

  /** A valid store with `edit` applied (JSON-like, untyped). */
  function variant(edit: (store: any) => void): string {
    const copy = structuredClone(validStore()) as any;
    edit(copy);
    return JSON.stringify(copy, null, 2);
  }

  function expectNoMarker(result: unknown): void {
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_CORRUPT" },
    });
    const { error } = result as {
      error: { message: string; details?: unknown };
    };
    // Case-insensitive: schema messages may quote normalised (lower-case) values.
    const marker = MARKER.toLowerCase();
    expect(error.message.toLowerCase()).not.toContain(marker);
    expect(JSON.stringify(error.details ?? null).toLowerCase()).not.toContain(
      marker,
    );
    expect(error).not.toHaveProperty("details");
  }

  const corruptContents: [string, string][] = [
    ["invalid JSON with the marker", `{ "favorites": [{ "name": "${MARKER}" `],
    ["a bare string with the marker", `"${MARKER}`],
    [
      "an unknown version holding the marker",
      variant((s) => (s.version = MARKER)),
    ],
    [
      "the marker as a duplicate alias",
      variant((s) => {
        s.favorites[0].aliases = [MARKER];
        s.favorites[1].aliases = [MARKER];
      }),
    ],
    [
      "the marker in an untrimmed name",
      variant((s) => (s.favorites[0].name = ` ${MARKER}`)),
    ],
    ["the marker as an unknown key", variant((s) => (s[MARKER] = MARKER))],
  ];

  test.each(corruptContents)(
    "read(): %s gives a generic STORAGE_CORRUPT without the marker; the file is unchanged and the log has the detail",
    async (_label, content) => {
      const before = await writeStoreFile(content);
      const result = await createJsonFileStore(storePath, options()).read();
      expectNoMarker(result);
      expect(await readFile(storePath)).toEqual(before);
      expect(logs.some((m) => m.includes(storePath))).toBe(true);
    },
  );

  test.each(corruptContents)(
    "update(): %s gives a generic STORAGE_CORRUPT without the marker; fn is not called and the file is unchanged",
    async (_label, content) => {
      const before = await writeStoreFile(content);
      let called = false;
      const result = await createJsonFileStore(storePath, options()).update(
        (current) => ((called = true), addEntry(current)),
      );
      expectNoMarker(result);
      expect(called).toBe(false);
      expect(await readFile(storePath)).toEqual(before);
    },
  );

  test("update(): an invalid new state holding the marker is refused with a generic STORAGE_CORRUPT; the file is unchanged and the log has the detail", async () => {
    const before = await writeStoreFile(validStore());
    const result = await createJsonFileStore(storePath, options()).update(
      (current) => ({
        ok: true,
        value: undefined,
        next: {
          ...current,
          favorites: current.favorites.map((f, i) =>
            i < 2 ? { ...f, aliases: [MARKER] } : f,
          ),
        },
      }),
    );
    expectNoMarker(result);
    expect(await readFile(storePath)).toEqual(before);
    expect(await leftoverTempFiles()).toEqual([]);
    expect(
      logs.some((m) => m.toLowerCase().includes(MARKER.toLowerCase())),
    ).toBe(true);
  });
});

describe("update() (SPEC §4.6)", () => {
  test("first write: creates the missing directory and file under the lock, without temp files", async () => {
    const nested = join(dir, "data", "store.json");
    let lockedDuringUpdate = false;
    const store = createJsonFileStore(nested, options());
    const result = await store.update((current) => {
      lockedDuringUpdate = existsSync(`${nested}.lock`);
      expect(current).toEqual(emptyStore());
      return addEntry(current);
    });
    expect(result).toEqual({ ok: true, value: "written" });
    expect(lockedDuringUpdate).toBe(true);
    expect(existsSync(`${nested}.lock`)).toBe(false);
    expect((await store.read()).ok).toBe(true);
    expect((await readdir(join(dir, "data"))).sort()).toEqual(["store.json"]);
  });

  test("writes readable JSON that reads back identically", async () => {
    await writeStoreFile(validStore());
    const store = createJsonFileStore(storePath, options());
    await store.update(addEntry);
    const text = await readFile(storePath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const read = await store.read();
    expect(read.ok && read.value.list).toHaveLength(3);
  });

  test("AC-A15: a corrupt file is STORAGE_CORRUPT; the update function is not called and nothing is written", async () => {
    const before = await writeStoreFile("{ broken");
    const { fs, count } = recordingFs();
    let called = false;
    const result = await createJsonFileStore(storePath, options({ fs })).update(
      (current) => ((called = true), addEntry(current)),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_CORRUPT" },
    });
    expect(called).toBe(false);
    expect(count("writeFile")).toBe(0);
    expect(await readFile(storePath)).toEqual(before);
    expect(lockExists()).toBe(false);
  });

  test("a business error from the update function is passed through and nothing is written", async () => {
    const before = await writeStoreFile(validStore());
    const { fs, count } = recordingFs();
    const result = await createJsonFileStore(storePath, options({ fs })).update(
      () => ({
        ok: false,
        error: { code: "QUANTITY_LIMIT", message: "too many" },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "QUANTITY_LIMIT", message: "too many" },
    });
    expect(count("writeFile")).toBe(0);
    expect(count("rename")).toBe(0);
    expect(await readFile(storePath)).toEqual(before);
    expect(lockExists()).toBe(false);
  });

  test("an outcome without a new state writes nothing (e.g. a replay)", async () => {
    const before = await writeStoreFile(validStore());
    const { fs, count } = recordingFs();
    const result = await createJsonFileStore(storePath, options({ fs })).update(
      () => ({ ok: true, value: 42 }),
    );
    expect(result).toEqual({ ok: true, value: 42 });
    expect(count("writeFile")).toBe(0);
    expect(await readFile(storePath)).toEqual(before);
  });

  test("refuses to write a new state that is not a valid store", async () => {
    const before = await writeStoreFile(validStore());
    const result = await createJsonFileStore(storePath, options()).update(
      (current) => ({
        ok: true,
        value: "x",
        next: { ...current, list: [{ ...current.list[0]!, quantity: 0 }] },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_CORRUPT" },
    });
    expect(await readFile(storePath)).toEqual(before);
  });

  test("AC-A14: a failing write is STORAGE_UNAVAILABLE, reports no success and leaves the file unchanged", async () => {
    const before = await writeStoreFile(validStore());
    const { fs } = recordingFs({
      writeFile: () => Promise.reject(errno("ENOSPC")),
    });
    const result = await createJsonFileStore(storePath, options({ fs })).update(
      addEntry,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", details: { cause: "ENOSPC" } },
    });
    expect(await readFile(storePath)).toEqual(before);
    expect(await leftoverTempFiles()).toEqual([]);
    expect(lockExists()).toBe(false);
  });

  test("AC-ST5: rename fails with EPERM/EBUSY a few times and then succeeds; the lock is held throughout", async () => {
    await writeStoreFile(validStore());
    const failures = ["EPERM", "EBUSY", "EPERM"];
    const lockStates: boolean[] = [];
    const { fs, count } = recordingFs({
      rename: (from, to) => {
        lockStates.push(lockExists());
        const code = failures.shift();
        return code ? Promise.reject(errno(code)) : nodeFs.rename(from, to);
      },
    });
    const result = await createJsonFileStore(storePath, options({ fs })).update(
      addEntry,
    );
    expect(result).toEqual({ ok: true, value: "written" });
    expect(count("rename")).toBe(4);
    expect(lockStates).toEqual([true, true, true, true]);
    const text = await readFile(storePath, "utf8");
    expect(JSON.parse(text).list).toHaveLength(3);
    expect(await leftoverTempFiles()).toEqual([]);
  });

  test("AC-ST6: rename keeps failing until the timeout: STORAGE_UNAVAILABLE, file unchanged, temp file removed", async () => {
    const before = await writeStoreFile(validStore());
    const { fs, calls, count } = recordingFs({
      rename: () => Promise.reject(errno("EBUSY")),
    });
    const started = Date.now();
    const result = await createJsonFileStore(
      storePath,
      options({ fs, renameTimeoutMs: 200, renameRetryIntervalMs: 20 }),
    ).update(addEntry);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", details: { cause: "EBUSY" } },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(count("rename")).toBeGreaterThan(2);
    expect(await readFile(storePath)).toEqual(before);
    expect(await leftoverTempFiles()).toEqual([]);
    // The existing store file is never deleted.
    expect(
      calls.filter((c) => c.op === "unlink" && c.path === storePath),
    ).toEqual([]);
    expect(lockExists()).toBe(false);
  });

  test("AC-ST7: rename and temp-file cleanup both fail: STORAGE_UNAVAILABLE for the rename, cleanup failure logged, file unchanged", async () => {
    const before = await writeStoreFile(validStore());
    const { fs } = recordingFs({
      rename: () => Promise.reject(errno("EPERM")),
      unlink: () => Promise.reject(errno("EACCES")),
    });
    const result = await createJsonFileStore(storePath, options({ fs })).update(
      addEntry,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", details: { cause: "EPERM" } },
    });
    expect(logs.some((m) => m.includes("EACCES") && m.includes(".tmp"))).toBe(
      true,
    );
    expect(await readFile(storePath)).toEqual(before);
    expect(lockExists()).toBe(false);
  });

  test("does not retry a rename error other than EPERM/EBUSY", async () => {
    const before = await writeStoreFile(validStore());
    const { fs, count } = recordingFs({
      rename: () => Promise.reject(errno("EXDEV")),
    });
    const result = await createJsonFileStore(storePath, options({ fs })).update(
      addEntry,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE" },
    });
    expect(count("rename")).toBe(1);
    expect(await readFile(storePath)).toEqual(before);
  });

  test("releases the lock when the update function throws", async () => {
    await writeStoreFile(validStore());
    const store = createJsonFileStore(storePath, options());
    await expect(
      store.update(() => {
        throw new Error("bug");
      }),
    ).rejects.toThrow("bug");
    expect(lockExists()).toBe(false);
    expect(await store.update(addEntry)).toEqual({
      ok: true,
      value: "written",
    });
  });

  test("a directory that cannot be created is STORAGE_UNAVAILABLE", async () => {
    await writeFile(join(dir, "blocker"), "");
    const store = createJsonFileStore(
      join(dir, "blocker", "store.json"),
      options(),
    );
    expect(await store.update(addEntry)).toMatchObject({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE" },
    });
  });

  test("accepts lock timings within the library limits and rejects others", () => {
    expect(() =>
      createJsonFileStore(storePath, { lockStaleMs: 2000, lockUpdateMs: 1000 }),
    ).not.toThrow();
    expect(() => createJsonFileStore(storePath, { lockStaleMs: 1000 })).toThrow(
      /lockStaleMs/,
    );
    expect(() =>
      createJsonFileStore(storePath, { lockStaleMs: 4000, lockUpdateMs: 3000 }),
    ).toThrow(/lockUpdateMs/);
    expect(() =>
      createJsonFileStore(storePath, { lockStaleMs: 4000, lockUpdateMs: 500 }),
    ).toThrow(/lockUpdateMs/);
  });
});

describe("lock lost while writing (SPEC §4.6, A9)", () => {
  const LOCK_TIMINGS = { lockStaleMs: 2000, lockUpdateMs: 1000 };
  const FOREIGN_MTIME = new Date("2026-01-01T00:00:00.000Z");
  const lockDir = () => `${storePath}.lock`;

  /**
   * "Another process" replaces the lock directory (as after a stale
   * takeover). The library notices on its next refresh attempt that actually
   * runs (nominally after lockUpdateMs) and reports the lock as compromised;
   * `takeOver` resolves only then, so the test waits for the event itself.
   */
  function lockLoss() {
    let noticed: () => void = () => {};
    const compromised = new Promise<void>((resolve) => (noticed = resolve));
    const log = (message: string) => {
      logs.push(message);
      if (message.includes("compromised")) noticed();
    };
    const takeOver = async () => {
      await nodeFs.rm(lockDir(), { recursive: true, force: true });
      await nodeFs.mkdir(lockDir());
      await nodeFs.utimes(lockDir(), FOREIGN_MTIME, FOREIGN_MTIME);
      await compromised;
    };
    return { log, takeOver };
  }

  async function expectForeignLockUntouched(): Promise<void> {
    expect(existsSync(lockDir())).toBe(true);
    expect((await nodeFs.stat(lockDir())).mtime.getTime()).toBe(
      FOREIGN_MTIME.getTime(),
    );
  }

  test("lock loss detected while the temp file is written: no rename, no success", async () => {
    const before = await writeStoreFile(validStore());
    const { log, takeOver } = lockLoss();
    const { fs, calls, count } = recordingFs({
      writeFile: async (path, data, opts) => {
        await takeOver();
        return nodeFs.writeFile(path, data, opts);
      },
    });

    const result = await createJsonFileStore(
      storePath,
      options({ ...LOCK_TIMINGS, fs, log }),
    ).update(addEntry);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "STORAGE_UNAVAILABLE",
        details: { cause: "ECOMPROMISED" },
      },
    });
    expect(count("rename")).toBe(0);
    expect(await readFile(storePath)).toEqual(before);
    expect(await leftoverTempFiles()).toEqual([]);
    expect(
      calls.filter((c) => c.path === storePath && c.op === "unlink"),
    ).toEqual([]);
    await expectForeignLockUntouched();
  }, 15_000);

  test("lock loss detected after a failed rename: no further rename attempt", async () => {
    const before = await writeStoreFile(validStore());
    const { log, takeOver } = lockLoss();
    let firstAttempt = true;
    const { fs, count } = recordingFs({
      rename: async (from, to) => {
        if (!firstAttempt) return nodeFs.rename(from, to);
        firstAttempt = false;
        await takeOver();
        throw errno("EBUSY");
      },
    });

    // A long rename timeout: without the lock check a retry would follow.
    const result = await createJsonFileStore(
      storePath,
      options({ ...LOCK_TIMINGS, fs, log, renameTimeoutMs: 10_000 }),
    ).update(addEntry);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "STORAGE_UNAVAILABLE",
        details: { cause: "ECOMPROMISED" },
      },
    });
    expect(count("rename")).toBe(1);
    expect(await readFile(storePath)).toEqual(before);
    expect(await leftoverTempFiles()).toEqual([]);
    await expectForeignLockUntouched();
  }, 15_000);

  test("lock loss plus a failing temp-file cleanup: the lock loss is reported, the cleanup failure only logged", async () => {
    const before = await writeStoreFile(validStore());
    const { log, takeOver } = lockLoss();
    const { fs, count } = recordingFs({
      writeFile: async (path, data, opts) => {
        await takeOver();
        return nodeFs.writeFile(path, data, opts);
      },
      unlink: () => Promise.reject(errno("EACCES")),
    });

    const result = await createJsonFileStore(
      storePath,
      options({ ...LOCK_TIMINGS, fs, log }),
    ).update(addEntry);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "STORAGE_UNAVAILABLE",
        details: { cause: "ECOMPROMISED" },
      },
    });
    expect(count("rename")).toBe(0);
    expect(logs.some((m) => m.includes("EACCES") && m.includes(".tmp"))).toBe(
      true,
    );
    expect(await readFile(storePath)).toEqual(before);
    await expectForeignLockUntouched();
  }, 15_000);
});
