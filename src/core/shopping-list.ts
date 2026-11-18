// The open shopping list (SPEC §6.3). Pure, no I/O.

import type { ListEntry } from "./types";

/**
 * Open entries only, ordered by `addedAt` ascending. Timestamps are compared
 * as points in time; equal timestamps keep the store order (stable sort).
 */
export function openEntries(list: readonly ListEntry[]): ListEntry[] {
  return list
    .filter((entry) => entry.status === "open")
    .sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt));
}
