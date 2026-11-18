// JSON file adapter for the Store interface (SPEC §4.6, A9).
//
// update(fn): mkdir → cross-process lock (proper-lockfile) → read + validate
// → fn → write to a unique temp file in the same directory → rename over the
// store file (retried on EPERM/EBUSY; the lock state is checked before every
// attempt) → release the lock. The existing store file is never deleted; it
// is only replaced by the rename.

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lock } from "proper-lockfile";
import type { CoreError, Result } from "../core/errors";
import { emptyStore, validateStoreFile } from "../core/store-schema";
import type { StoreFile } from "../core/types";
import type { Store, UpdateDecision } from "./store";

/** The file operations used by the store; replaceable in tests to simulate I/O errors. */
export type FileSystem = {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx"; flush: true },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
};

/**
 * Internal options. The defaults follow the SPEC; tests may use short
 * values. Not exposed as user configuration.
 */
export type JsonFileStoreOptions = {
  readonly lockTimeoutMs?: number;
  readonly lockRetryIntervalMs?: number;
  readonly lockStaleMs?: number;
  readonly lockUpdateMs?: number;
  readonly renameTimeoutMs?: number;
  readonly renameRetryIntervalMs?: number;
  readonly fs?: Partial<FileSystem>;
  readonly log?: (message: string) => void;
};

export type HeldLock = {
  release(): Promise<void>;
  readonly isCompromised: () => boolean;
};

const DEFAULTS = {
  lockTimeoutMs: 5000, // SPEC §4.6
  lockRetryIntervalMs: 100,
  lockStaleMs: 4000, // SPEC A9
  lockUpdateMs: 1000, // SPEC A9
  renameTimeoutMs: 2000, // SPEC §4.6
  renameRetryIntervalMs: 50, // SPEC §4.6
} as const;

// Limits enforced by proper-lockfile (it would silently clamp otherwise).
const LIBRARY_MIN_STALE_MS = 2000;
const LIBRARY_MIN_UPDATE_MS = 1000;

const RETRYABLE_RENAME_ERRORS = new Set(["EPERM", "EBUSY"]);

const defaultFs: FileSystem = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (path) => nodeFs.unlink(path),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
};

type Settings = Required<Omit<JsonFileStoreOptions, "fs" | "log">> & {
  readonly fs: FileSystem;
  readonly log: (message: string) => void;
};

function settings(options: JsonFileStoreOptions): Settings {
  const s: Settings = {
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULTS.lockTimeoutMs,
    lockRetryIntervalMs:
      options.lockRetryIntervalMs ?? DEFAULTS.lockRetryIntervalMs,
    lockStaleMs: options.lockStaleMs ?? DEFAULTS.lockStaleMs,
    lockUpdateMs: options.lockUpdateMs ?? DEFAULTS.lockUpdateMs,
    renameTimeoutMs: options.renameTimeoutMs ?? DEFAULTS.renameTimeoutMs,
    renameRetryIntervalMs:
      options.renameRetryIntervalMs ?? DEFAULTS.renameRetryIntervalMs,
    fs: { ...defaultFs, ...options.fs },
    log:
      options.log ??
      ((message) =>
        process.stderr.write(`[einkaufshelfer store] ${message}\n`)),
  };
  if (s.lockStaleMs < LIBRARY_MIN_STALE_MS) {
    throw new Error(`lockStaleMs must be at least ${LIBRARY_MIN_STALE_MS} ms`);
  }
  if (
    s.lockUpdateMs < LIBRARY_MIN_UPDATE_MS ||
    s.lockUpdateMs > s.lockStaleMs / 2
  ) {
    throw new Error(
      `lockUpdateMs must be between ${LIBRARY_MIN_UPDATE_MS} ms and lockStaleMs / 2`,
    );
  }
  for (const key of [
    "lockTimeoutMs",
    "lockRetryIntervalMs",
    "renameTimeoutMs",
    "renameRetryIntervalMs",
  ] as const) {
    if (!(s[key] >= 0)) throw new Error(`${key} must be a non-negative number`);
  }
  return s;
}

export function createJsonFileStore(
  path: string,
  options: JsonFileStoreOptions = {},
): Store {
  const s = settings(options);

  return {
    path,
    read: () => readState(path, s),

    async update<T>(
      fn: (current: StoreFile) => UpdateDecision<T>,
    ): Promise<Result<T>> {
      const dir = dirname(path);
      try {
        await s.fs.mkdir(dir, { recursive: true });
      } catch (error) {
        return unavailable(
          `cannot create the store directory ${dir}`,
          path,
          error,
        );
      }

      const locked = await lockWithTimeout(path, s);
      if (!locked.ok) return locked;
      const held = locked.value;
      try {
        const current = await readState(path, s);
        if (!current.ok) return current;

        const decision = fn(current.value);
        if (!decision.ok) return { ok: false, error: decision.error };
        if (decision.next === undefined)
          return { ok: true, value: decision.value };

        const valid = validateStoreFile(decision.next);
        if (!valid.ok) {
          return failure({
            ...valid.error,
            message: `refusing to write invalid store content: ${valid.error.message}`,
          });
        }
        if (held.isCompromised()) return lockLost(path);

        const written = await writeAtomically(
          path,
          serialize(decision.next),
          s,
          held.isCompromised,
        );
        if (!written.ok) return written;
        return { ok: true, value: decision.value };
      } finally {
        // A lost lock may by now belong to another process: never remove it.
        // (proper-lockfile already treats a compromised lock as released.)
        if (!held.isCompromised()) {
          try {
            await held.release();
          } catch (error) {
            s.log(
              `could not release the store lock ${path}.lock: ${describe(error)}`,
            );
          }
        }
      }
    },
  };
}

/** Acquires the store lock (internal; exported for process tests). */
export async function acquireStoreLock(
  path: string,
  options: JsonFileStoreOptions = {},
): Promise<HeldLock> {
  const locked = await lockWithTimeout(path, settings(options));
  if (!locked.ok) throw new Error(locked.error.message);
  return locked.value;
}

/**
 * Takes the lock directory `<path>.lock` via proper-lockfile. Attempts are
 * repeated until `lockTimeoutMs`. A lock is only taken over when its mtime
 * is older than `lockStaleMs` (holder crashed); an active holder refreshes
 * the mtime, nominally every `lockUpdateMs` while its event loop runs, so it
 * is not taken over merely because others wait. A lost lock is noticed only
 * at the next refresh attempt that actually runs (no fixed time bound).
 */
async function lockWithTimeout(
  path: string,
  s: Settings,
): Promise<Result<HeldLock>> {
  let compromised = false;
  const deadline = Date.now() + s.lockTimeoutMs;
  for (;;) {
    try {
      const release = await lock(path, {
        realpath: false, // the store file may not exist yet
        stale: s.lockStaleMs,
        update: s.lockUpdateMs,
        retries: 0,
        onCompromised: (error) => {
          compromised = true;
          s.log(
            `the store lock ${path}.lock was compromised: ${describe(error)}`,
          );
        },
      });
      return { ok: true, value: { release, isCompromised: () => compromised } };
    } catch (error) {
      if (errorCode(error) !== "ELOCKED") {
        return unavailable(`cannot lock the store ${path}`, path, error);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return unavailable(
          `timed out after ${s.lockTimeoutMs} ms waiting for the store lock ${path}.lock`,
          path,
          error,
        );
      }
      await sleep(Math.min(s.lockRetryIntervalMs, remaining));
    }
  }
}

async function readState(
  path: string,
  s: Settings,
): Promise<Result<StoreFile>> {
  let text: string;
  try {
    text = await s.fs.readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, value: emptyStore() };
    return unavailable(`cannot read the store ${path}`, path, error);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return failure({
      code: "STORAGE_CORRUPT",
      message: `the store ${path} is not valid JSON: ${describe(error)}`,
      details: { path },
    });
  }

  const valid = validateStoreFile(data);
  if (!valid.ok) {
    return failure({
      ...valid.error,
      message: `the store ${path} is invalid: ${valid.error.message}`,
      details: { ...valid.error.details, path },
    });
  }
  return valid;
}

/**
 * Writes the temp file and renames it over the store file. The known lock
 * state is checked immediately before every rename attempt: once the lock
 * is lost, no further rename is started. A rename that has already started
 * cannot be taken back (SPEC A9).
 */
async function writeAtomically(
  path: string,
  content: string,
  s: Settings,
  isLockLost: () => boolean,
): Promise<Result<void>> {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await s.fs.writeFile(temp, content, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
    });
  } catch (error) {
    await removeTempFile(temp, s);
    return unavailable(`cannot write the temp file ${temp}`, path, error);
  }

  const started = Date.now();
  for (;;) {
    if (isLockLost()) {
      // Store file and the (possibly foreign) lock stay untouched.
      await removeTempFile(temp, s);
      return lockLost(path);
    }
    try {
      await s.fs.rename(temp, path);
      return { ok: true, value: undefined };
    } catch (error) {
      const remaining = s.renameTimeoutMs - (Date.now() - started);
      if (
        RETRYABLE_RENAME_ERRORS.has(errorCode(error) ?? "") &&
        remaining > 0
      ) {
        await sleep(Math.min(s.renameRetryIntervalMs, remaining));
        continue;
      }
      // The store file is untouched; only the temp file has to go.
      await removeTempFile(temp, s);
      return unavailable(`cannot replace the store ${path}`, path, error);
    }
  }
}

/** Best effort; a cleanup failure is logged and never replaces the original error. */
async function removeTempFile(temp: string, s: Settings): Promise<void> {
  try {
    await s.fs.unlink(temp);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      s.log(`could not remove the temp file ${temp}: ${describe(error)}`);
    }
  }
}

function serialize(store: StoreFile): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

function lockLost(path: string): Result<never> {
  return failure({
    code: "STORAGE_UNAVAILABLE",
    message: `the store lock ${path}.lock was lost before the store could be replaced; nothing was written`,
    details: { path, cause: "ECOMPROMISED" },
  });
}

function unavailable(
  message: string,
  path: string,
  error?: unknown,
): Result<never> {
  const cause = errorCode(error);
  return failure({
    code: "STORAGE_UNAVAILABLE",
    message: error === undefined ? message : `${message}: ${describe(error)}`,
    details: { path, ...(cause !== undefined ? { cause } : {}) },
  });
}

function failure(error: CoreError): Result<never> {
  return { ok: false, error };
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function describe(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code !== undefined && !message.includes(code)
    ? `${code} ${message}`
    : message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
