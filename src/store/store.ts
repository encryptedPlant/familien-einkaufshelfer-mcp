// Storage interface (SPEC §4.6). Other adapters can implement it later
// without changes to the core logic.

import type { CoreError, Result } from "../core/errors";
import type { StoreFile } from "../core/types";

/**
 * What an update function decides: an error (nothing is written), or a
 * value plus optionally the new state. Without `next` nothing is written
 * (e.g. a replayed request); with `next` the whole document is replaced.
 */
export type UpdateDecision<T> =
  | { readonly ok: true; readonly value: T; readonly next?: StoreFile }
  | { readonly ok: false; readonly error: CoreError };

export interface Store {
  /** Absolute path of the backing file (for logging). */
  readonly path: string;
  /** Reads and validates the current state; never creates the file. */
  read(): Promise<Result<StoreFile>>;
  /**
   * Read → `fn` → write under an exclusive cross-process lock. An error
   * returned by `fn` is passed through and nothing is written. A success is
   * only returned after the new state has been written.
   */
  update<T>(fn: (current: StoreFile) => UpdateDecision<T>): Promise<Result<T>>;
}
