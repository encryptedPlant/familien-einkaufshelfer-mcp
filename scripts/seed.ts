// `npm run seed`: writes the fictional sample favourites into a missing or
// empty store. Uses the shared store path, store logic and lock.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createJsonFileStore } from "../src/store/json-file-store";
import { projectRoot, resolveStorePath } from "../src/store/path";
import { seedFavorites } from "../src/store/seed";

async function main(): Promise<number> {
  const samplePath = join(projectRoot(), "data", "sample-favorites.json");
  let favorites: unknown;
  try {
    favorites = JSON.parse(await readFile(samplePath, "utf8"));
  } catch (error) {
    console.error(`Cannot read ${samplePath}: ${String(error)}`);
    return 1;
  }

  const store = createJsonFileStore(resolveStorePath());
  const result = await seedFavorites(store, favorites);
  if (!result.ok) {
    console.error(`${result.error.code}: ${result.error.message}`);
    return 1;
  }
  if (result.value.status === "not-empty") {
    console.error(`Store ${store.path} is not empty; nothing was changed.`);
    return 1;
  }
  console.log(
    `Seeded ${result.value.count} sample favourites into ${store.path}`,
  );
  return 0;
}

process.exitCode = await main();
