// get_favorites and save_favorite through the real MCP server process
// (SDK client over stdio). Only temp stores and fictional data; dm is never called.

import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { emptyStore } from "../../src/core/store-schema";
import type { StoreFile } from "../../src/core/types";
import { dishSoap, toothpasteMint, wetWipes } from "../fixtures/favorites";
import { makeTempDir, removeTempDir, ROOT } from "../store/processes";
import { call, closeAll, connect } from "./client";

const TIMEOUT = 30_000;

let dir: string;
let storePath: string;

beforeEach(async () => {
  dir = await makeTempDir();
  storePath = join(dir, "store.json");
});
afterEach(async () => {
  await closeAll();
  await removeTempDir(dir);
});

async function writeStore(state: StoreFile): Promise<Buffer> {
  await writeFile(storePath, JSON.stringify(state, null, 2));
  return readFile(storePath);
}

const withFavorites = (): StoreFile => ({
  ...emptyStore(),
  favorites: [wetWipes, toothpasteMint, dishSoap],
});

const handCream = {
  name: "Handcreme Mandel",
  category: "Körperpflege",
  aliases: ["die übliche Handcreme"],
  dmArticleNumber: "900100",
  dmUrl: "https://www.dm.de/beispiel-handcreme-mandel-p900100.html",
};

describe("favourite tools via MCP (SPEC §6.5, §6.6)", () => {
  test(
    "[protocol] annotations: get_favorites read-only; save_favorite writes and is not idempotent",
    async () => {
      const server = await connect({ storePath });
      const { tools } = await server.client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.get_favorites?.annotations).toMatchObject({
        readOnlyHint: true,
      });
      expect(byName.save_favorite?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
      });
      expect(byName.save_favorite?.inputSchema).toMatchObject({
        type: "object",
        required: ["name", "category"],
      });
      expect(byName.save_favorite?.description).toMatch(/get_favorites/);
      expect(byName.save_favorite?.description).toMatch(/not idempotent/i);
    },
    TIMEOUT,
  );

  test(
    "AC-F1: get_favorites returns all favourites with name, category, aliases and dm identifiers; the file stays unchanged",
    async () => {
      const before = await writeStore(withFavorites());
      const server = await connect({ storePath });
      const result = await call(server, "get_favorites", {});
      expect(result.isError).toBe(false);
      expect(result.body).toEqual({
        favorites: [wetWipes, toothpasteMint, dishSoap],
      });
      expect(await readFile(storePath)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "get_favorites on a missing store returns an empty list and creates no file",
    async () => {
      const server = await connect({ storePath });
      expect(await call(server, "get_favorites", {})).toEqual({
        isError: false,
        body: { favorites: [] },
      });
      expect(existsSync(storePath)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "AC-S1: a saved favourite is returned with a server-generated id and createdAt, then listed, resolved by its alias and addable",
    async () => {
      await writeStore(withFavorites());
      const server = await connect({ storePath });
      const saved = await call(server, "save_favorite", {
        ...handCream,
        name: "  Handcreme Mandel ",
        dmUrl: "https://DM.de/beispiel-handcreme-mandel-p900100.html/?ref=app",
      });
      expect(saved.isError).toBe(false);
      const favorite = saved.body.favorite;
      expect(favorite).toMatchObject({ ...handCream });
      expect(favorite.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(favorite.createdAt)).not.toBeNaN();

      const listed = await call(server, "get_favorites", {});
      expect(listed.body.favorites.at(-1)).toEqual(favorite);

      const resolved = await call(server, "resolve_items", {
        items: [{ term: "Die übliche HANDCREME", quantity: 2 }],
      });
      expect(resolved.body.results[0]).toMatchObject({
        status: "resolved",
        favorite: { id: favorite.id },
      });

      const added = await call(server, "add_to_shopping_list", {
        requestId: "req-handcreme",
        items: [{ favoriteId: favorite.id, quantity: 2 }],
      });
      expect(added.body).toMatchObject({
        entries: [{ quantity: 2, action: "created" }],
      });
    },
    TIMEOUT,
  );

  test(
    "AC-S2: an alias that collides after normalisation is DUPLICATE_ALIAS and nothing is saved",
    async () => {
      const before = await writeStore(withFavorites());
      const server = await connect({ storePath });
      const result = await call(server, "save_favorite", {
        name: "Spülmittel Lavendel",
        category: "Haushalt",
        aliases: [" SPÜLI "],
      });
      expect(result.isError).toBe(true);
      expect(result.body).toMatchObject({
        code: "DUPLICATE_ALIAS",
        message: expect.any(String),
        details: { alias: "SPÜLI" },
      });
      expect(await readFile(storePath)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "AC-S3: a favourite with an existing name can be saved",
    async () => {
      await writeStore(withFavorites());
      const server = await connect({ storePath });
      const result = await call(server, "save_favorite", {
        name: wetWipes.name,
        category: wetWipes.category,
      });
      expect(result.isError).toBe(false);
      const listed = await call(server, "get_favorites", {});
      expect(
        listed.body.favorites.filter(
          (f: { name: string }) => f.name === wetWipes.name,
        ),
      ).toHaveLength(2);
    },
    TIMEOUT,
  );

  test(
    "AC-S4 / VALIDATION_ERROR: whitespace-only fields and the dm start page are rejected and nothing is saved",
    async () => {
      const before = await writeStore(withFavorites());
      const server = await connect({ storePath });
      const result = await call(server, "save_favorite", {
        name: " ",
        category: "Haushalt",
        aliases: ["Kerzen", "  "],
        dmUrl: "https://www.dm.de/#angebote",
      });
      expect(result.isError).toBe(true);
      expect(result.body.code).toBe("VALIDATION_ERROR");
      expect(
        result.body.details.issues.map((i: { path: string }) => i.path).sort(),
      ).toEqual(["aliases.1", "dmUrl", "name"]);
      expect(await readFile(storePath)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "a storage failure is reported as STORAGE_UNAVAILABLE without a success message",
    async () => {
      await writeFile(join(dir, "blocker"), "");
      const server = await connect({
        storePath: join(dir, "blocker", "store.json"),
      });
      const result = await call(server, "save_favorite", {
        name: "Teelichter",
        category: "Haushalt",
      });
      expect(result).toMatchObject({
        isError: true,
        body: { code: "STORAGE_UNAVAILABLE" },
      });
      expect(result.body).not.toHaveProperty("favorite");
    },
    TIMEOUT,
  );
});

describe("project MCP configuration (.mcp.json)", () => {
  test("[config] keeps the demo einkaufshelfer entry and adds dm's public MCP server without credentials", () => {
    const config = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8"));
    expect(config.mcpServers.einkaufshelfer).toMatchObject({
      command: "node",
      env: { EINKAUFSHELFER_DATA_FILE: "data/demo-store.json" },
    });
    const dm = config.mcpServers["dm-drogeriemarkt"];
    expect(dm).toEqual({ type: "http", url: "https://mcp.dm.de/mcp" });
  });
});
