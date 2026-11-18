import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Result } from "../../src/core/errors";
import type { AddResult, StoreFile } from "../../src/core/types";
import { createJsonFileStore } from "../../src/store/json-file-store";
import { toothpasteMint } from "../fixtures/favorites";
import { validStore } from "../fixtures/store";
import {
  killAllWorkers,
  makeTempDir,
  removeTempDir,
  startWorker,
  type Worker,
} from "./processes";

const TIMEOUT = 30_000;
const NOW = "2026-02-10T09:00:00.000Z";

let dir: string;
let storePath: string;

beforeEach(async () => {
  dir = await makeTempDir();
  storePath = join(dir, "store.json");
  await writeFile(storePath, JSON.stringify(validStore(), null, 2));
});
afterEach(async () => {
  await killAllWorkers();
  await removeTempDir(dir);
});

async function readStore(): Promise<StoreFile> {
  return JSON.parse(await readFile(storePath, "utf8")) as StoreFile;
}

function addWorker(
  idPrefix: string,
  requests: { requestId: string; items: unknown }[],
  waitForGo: boolean,
): Worker {
  return startWorker({
    type: "add",
    storePath,
    requests,
    idPrefix,
    now: NOW,
    waitForGo,
    options: { lockRetryIntervalMs: 10 },
  });
}

async function results(worker: Worker): Promise<Result<AddResult>[]> {
  const done = await worker.next("done");
  return done.results as Result<AddResult>[];
}

/** Starts the given workers, waits until all are ready, then releases them at once. */
async function startTogether(workers: Worker[]): Promise<void> {
  await Promise.all(workers.map((w) => w.next("ready")));
  for (const w of workers) w.send("go");
}

const product = (worker: string, i: number) => ({
  requestId: `req-${worker}-${i}`,
  items: [
    {
      product: {
        name: `Testprodukt ${worker}${i}`,
        dmArticleNumber: `7${worker === "a" ? 1 : 2}${String(i).padStart(3, "0")}`,
      },
      quantity: 1,
    },
  ],
});

describe("storage with separate OS processes (SPEC §6.4)", () => {
  test(
    "AC-ST1: two processes concurrently add different products; all changes are kept",
    async () => {
      const count = 8;
      const a = addWorker(
        "aaaaaaaa",
        Array.from({ length: count }, (_, i) => product("a", i)),
        true,
      );
      const b = addWorker(
        "bbbbbbbb",
        Array.from({ length: count }, (_, i) => product("b", i)),
        true,
      );
      await startTogether([a, b]);
      const [ra, rb] = await Promise.all([results(a), results(b)]);

      expect([...ra, ...rb].every((r) => r.ok && !r.value.replayed)).toBe(true);
      const store = await readStore();
      expect(store.list).toHaveLength(2 + 2 * count);
      expect(store.processedRequests).toHaveLength(1 + 2 * count);
      for (const r of [...ra, ...rb]) {
        if (!r.ok) continue;
        expect(store.list.map((e) => e.id)).toContain(
          r.value.entries[0]?.entryId,
        );
      }
      expect(await a.exited).toBe(0);
      expect(await b.exited).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "AC-ST2: after a successful request, a new process repeating the requestId gets replayed: true and nothing changes",
    async () => {
      const req = {
        requestId: "req-restart",
        items: [{ favoriteId: toothpasteMint.id, quantity: 2 }],
      };
      const first = await results(addWorker("cccccccc", [req], false));
      const afterFirst = await readFile(storePath);
      const second = await results(addWorker("dddddddd", [req], false));

      expect(first[0]).toMatchObject({ ok: true, value: { replayed: false } });
      expect(second[0]).toEqual({
        ok: true,
        value: { ...(first[0] as { value: AddResult }).value, replayed: true },
      });
      expect(await readFile(storePath)).toEqual(afterFirst);
      const entry = (await readStore()).list.find(
        (e) => e.favoriteId === toothpasteMint.id,
      );
      expect(entry?.quantity).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "AC-ST3: two processes send the same request concurrently; it is applied exactly once",
    async () => {
      const req = {
        requestId: "req-same",
        items: [{ favoriteId: toothpasteMint.id, quantity: 2 }],
      };
      const a = addWorker("eeeeeeee", [req], true);
      const b = addWorker("ffffffff", [req], true);
      await startTogether([a, b]);
      const [ra, rb] = await Promise.all([results(a), results(b)]);

      const replayed = [ra[0], rb[0]].map((r) =>
        r?.ok ? r.value.replayed : "error",
      );
      expect(replayed.sort()).toEqual([false, true]);
      const store = await readStore();
      const entries = store.list.filter(
        (e) => e.favoriteId === toothpasteMint.id,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.quantity).toBe(2);
      expect(
        store.processedRequests.filter((p) => p.requestId === "req-same"),
      ).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe("cross-process lock (SPEC §4.6, A9)", () => {
  test(
    "a lock held by another process beyond the timeout gives STORAGE_UNAVAILABLE; the file and the foreign lock stay untouched",
    async () => {
      const before = await readFile(storePath);
      const holder = startWorker({ type: "hold-lock", storePath });
      await holder.next("locked");

      const result = await createJsonFileStore(storePath, {
        lockTimeoutMs: 500,
        lockRetryIntervalMs: 50,
      }).update(() => ({ ok: true, value: "never", next: validStore() }));

      expect(result).toMatchObject({
        ok: false,
        error: { code: "STORAGE_UNAVAILABLE" },
      });
      expect(await readFile(storePath)).toEqual(before);
      expect(existsSync(`${storePath}.lock`)).toBe(true);
      holder.send("release");
      expect(await holder.next("released")).toMatchObject({
        compromised: false,
      });
      expect(await holder.exited).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "an actively refreshed lock is not taken over as stale, even when a process waits longer than the stale time",
    async () => {
      const lockTimings = { lockStaleMs: 2000, lockUpdateMs: 1000 };
      const holder = startWorker({
        type: "hold-lock",
        storePath,
        options: lockTimings,
      });
      await holder.next("locked");

      const started = Date.now();
      const result = await createJsonFileStore(storePath, {
        ...lockTimings,
        lockTimeoutMs: 3500,
        lockRetryIntervalMs: 50,
      }).update(() => ({ ok: true, value: "never", next: validStore() }));

      expect(Date.now() - started).toBeGreaterThanOrEqual(3500);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "STORAGE_UNAVAILABLE" },
      });
      holder.send("release");
      expect(await holder.next("released")).toMatchObject({
        compromised: false,
      });
    },
    TIMEOUT,
  );

  test(
    "a lock left behind by a killed process is taken over once it is stale, and the next write succeeds",
    async () => {
      const lockTimings = { lockStaleMs: 2000, lockUpdateMs: 1000 };
      const holder = startWorker({
        type: "hold-lock",
        storePath,
        options: lockTimings,
      });
      await holder.next("locked");
      await holder.kill();
      expect(existsSync(`${storePath}.lock`)).toBe(true);

      // Right after the crash the lock is still fresh and is not taken over.
      const early = await createJsonFileStore(storePath, {
        ...lockTimings,
        lockTimeoutMs: 200,
        lockRetryIntervalMs: 50,
      }).update(() => ({ ok: true, value: "early", next: validStore() }));
      expect(early).toMatchObject({
        ok: false,
        error: { code: "STORAGE_UNAVAILABLE" },
      });

      // Within the regular lock timeout the stale lock is taken over.
      const store = createJsonFileStore(storePath, {
        ...lockTimings,
        lockRetryIntervalMs: 50,
      });
      const result = await store.update((current) => ({
        ok: true,
        value: "recovered",
        next: { ...current, list: current.list.slice(0, 1) },
      }));
      expect(result).toEqual({ ok: true, value: "recovered" });
      expect((await readStore()).list).toHaveLength(1);
      expect(existsSync(`${storePath}.lock`)).toBe(false);
    },
    TIMEOUT,
  );
});
