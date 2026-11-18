// Canonical JSON and payload hash for idempotency (SPEC §4.5). Pure, no I/O.

import { createHash } from "node:crypto";
import type { AddItem } from "./types";

/**
 * JSON with object keys sorted recursively (by UTF-16 code unit order);
 * array order is kept. Keys with `undefined` values are omitted, as in
 * `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * SHA-256 (hex) over the canonical JSON of the validated and normalised
 * items. A `favoriteId` is hashed as given and never resolved, so later
 * changes to a favourite cannot affect the replay of a stored request.
 * Array order is significant.
 */
export function payloadHash(items: readonly AddItem[]): string {
  return createHash("sha256")
    .update(canonicalJson(items), "utf8")
    .digest("hex");
}
