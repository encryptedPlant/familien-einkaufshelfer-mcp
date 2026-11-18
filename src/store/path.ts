// The one shared store path function (SPEC §4.6).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cachedRoot: string | undefined;

/**
 * Directory containing this project's package.json, found by walking up
 * from this file's location, never from the working directory.
 */
export function projectRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return (cachedRoot = dir);
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "project root not found: no package.json above the store module",
      );
    }
    dir = parent;
  }
}

/**
 * Absolute store path: `<project root>/data/store.json`, or the value of
 * `EINKAUFSHELFER_DATA_FILE` (a relative value is resolved against the
 * project root; an empty value counts as unset). Independent of the
 * working directory.
 */
export function resolveStorePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const root = projectRoot();
  const override = env.EINKAUFSHELFER_DATA_FILE?.trim();
  if (override) return resolve(root, override);
  return join(root, "data", "store.json");
}
