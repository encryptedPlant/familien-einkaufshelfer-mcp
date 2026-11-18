// Integration tests: the real MCP server runs as a separate stdio process and
// is driven through the SDK client. Only temp stores and fictional data.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { emptyStore } from "../../src/core/store-schema";
import type { StoreFile } from "../../src/core/types";
import {
  dishSoap,
  toothpasteHerbal,
  toothpasteMint,
  wetWipes,
} from "../fixtures/favorites";
import { validStore } from "../fixtures/store";
import { makeTempDir, removeTempDir, ROOT } from "../store/processes";
import { call, closeAll, connect, ENTRY } from "./client";

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

async function writeStore(store: StoreFile): Promise<Buffer> {
  await writeFile(storePath, JSON.stringify(store, null, 2));
  return readFile(storePath);
}

const withFavorites = (): StoreFile => ({
  ...emptyStore(),
  favorites: [wetWipes, toothpasteMint, toothpasteHerbal, dishSoap],
});

async function quantityOf(
  favoriteId: string,
  server: Awaited<ReturnType<typeof connect>>,
) {
  const list = await call(server, "get_shopping_list", {});
  return list.body.entries
    .filter((e: { favoriteId?: string }) => e.favoriteId === favoriteId)
    .map((e: { quantity: number }) => e.quantity);
}

describe("protocol (additional protocol tests)", () => {
  test(
    "[protocol] lists exactly the five tools with input schemas and annotations",
    async () => {
      const server = await connect({ storePath });
      const { tools } = await server.client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(Object.keys(byName).sort()).toEqual([
        "add_to_shopping_list",
        "get_favorites",
        "get_shopping_list",
        "resolve_items",
        "save_favorite",
      ]);
      expect(byName.resolve_items?.annotations).toMatchObject({
        readOnlyHint: true,
      });
      expect(byName.get_shopping_list?.annotations).toMatchObject({
        readOnlyHint: true,
      });
      expect(byName.add_to_shopping_list?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      expect(byName.resolve_items?.inputSchema).toMatchObject({
        type: "object",
        required: ["items"],
      });
      expect(byName.add_to_shopping_list?.inputSchema).toMatchObject({
        type: "object",
        required: ["requestId", "items"],
      });
      expect(byName.get_shopping_list?.inputSchema).toMatchObject({
        type: "object",
        properties: {},
      });
      // Client guidance is part of the descriptions.
      expect(byName.resolve_items?.description).toMatch(/ambiguous/);
      expect(byName.resolve_items?.description).toMatch(
        /never invent a favoriteId/i,
      );
      expect(byName.add_to_shopping_list?.description).toMatch(
        /new unique requestId/i,
      );
      expect(byName.add_to_shopping_list?.description).toMatch(
        /REQUEST_ID_CONFLICT/,
      );
    },
    TIMEOUT,
  );

  test(
    "[protocol] stdout carries only JSON-RPC messages, the store path goes to stderr, and the server exits cleanly when stdin closes",
    async () => {
      const child = spawn(process.execPath, [ENTRY], {
        cwd: tmpdir(),
        // Next.js types make NODE_ENV required in ProcessEnv; not needed here.
        env: {
          ...getDefaultEnvironment(),
          EINKAUFSHELFER_DATA_FILE: storePath,
        } as unknown as NodeJS.ProcessEnv,
        stdio: "pipe",
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += String(c)));
      const exited = new Promise<number | null>((res) =>
        child.on("exit", (code) => res(code)),
      );
      const lines: string[] = [];
      const listed = new Promise<void>((res) => {
        createInterface({ input: child.stdout }).on("line", (line) => {
          lines.push(line);
          if (line.includes('"id":2')) res();
        });
      });

      const send = (message: object) =>
        child.stdin.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "raw-test", version: "0" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      await listed;
      child.stdin.end();

      expect(await exited).toBe(0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines)
        expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
      expect(stderr).toContain(storePath);
      expect(existsSync(storePath)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "[protocol] a direct node call from another working directory starts the server and uses the configured store",
    async () => {
      await writeStore(withFavorites());
      const server = await connect({ storePath, cwd: tmpdir() });
      const added = await call(server, "add_to_shopping_list", {
        requestId: "req-cwd",
        items: [{ favoriteId: wetWipes.id, quantity: 1 }],
      });
      expect(added.isError).toBe(false);
      const saved = JSON.parse(await readFile(storePath, "utf8")) as StoreFile;
      expect(saved.list).toHaveLength(1);
      expect(server.stderr()).toContain(storePath);
    },
    TIMEOUT,
  );

  test(
    "[protocol] the project .mcp.json starts the server with a portable node command (with and without CLAUDE_PROJECT_DIR)",
    async () => {
      const config = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8"));
      const entry = config.mcpServers.einkaufshelfer;
      expect(entry.command).toBe("node");
      for (const arg of entry.args as string[]) {
        expect(isAbsolute(arg)).toBe(false);
        expect(arg).not.toMatch(/^[A-Za-z]:|Users|home\//);
      }

      // Expand ${VAR:-default} the way Claude Code does, for both cases.
      const expand = (value: string, env: Record<string, string>) =>
        value.replace(
          /\$\{(\w+)(?::-([^}]*))?\}/g,
          (_m, name: string, fallback?: string) => env[name] ?? fallback ?? "",
        );
      for (const { cwd, env } of [
        { cwd: ROOT, env: {} },
        { cwd: tmpdir(), env: { CLAUDE_PROJECT_DIR: ROOT } },
      ]) {
        const server = await connect({
          storePath, // overrides the demo store from the config
          command: entry.command,
          args: (entry.args as string[]).map((a) => expand(a, env)),
          cwd,
          env: { ...entry.env, ...env },
        });
        const { tools } = await server.client.listTools();
        expect(tools).toHaveLength(5);
        await server.close();
      }
      expect(existsSync(storePath)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "[protocol] an unknown tool is a protocol error, not a tool result",
    async () => {
      const server = await connect({ storePath });
      await expect(
        server.client.callTool({ name: "add_to_cart", arguments: {} }),
      ).rejects.toThrow(/unknown tool/i);
    },
    TIMEOUT,
  );
});

describe("resolve_items via MCP (SPEC §6.1)", () => {
  test(
    "AC-R1, AC-R3, AC-R5: resolved, ambiguous and unknown in input order; AC-R6: the store file is unchanged",
    async () => {
      const before = await writeStore(withFavorites());
      const server = await connect({ storePath });
      const result = await call(server, "resolve_items", {
        items: [
          { term: "  Die üblichen  FEUCHTTÜCHER ", quantity: 2 },
          { term: "Zahnpasta" },
          { term: "Sonnencreme" },
        ],
      });
      expect(result.isError).toBe(false);
      expect(
        result.body.results.map((r: { status: string }) => r.status),
      ).toEqual(["resolved", "ambiguous", "unknown"]);
      expect(result.body.results[0]).toMatchObject({
        quantity: 2,
        favorite: { id: wetWipes.id },
      });
      expect(
        result.body.results[1].candidates.map((c: { id: string }) => c.id),
      ).toEqual([toothpasteMint.id, toothpasteHerbal.id]);
      expect(await readFile(storePath)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "AC-R7: invalid input is answered with isError and the SPEC error body",
    async () => {
      await writeStore(withFavorites());
      const server = await connect({ storePath });
      const result = await call(server, "resolve_items", {
        items: [{ term: "Spüli", quantity: 0 }],
      });
      expect(result.isError).toBe(true);
      expect(result.body).toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.any(String),
        details: { issues: [{ path: "items.0.quantity" }] },
      });
    },
    TIMEOUT,
  );
});

describe("add_to_shopping_list and get_shopping_list via MCP (SPEC §6.2, §6.3)", () => {
  const add = (
    requestId: string,
    quantity: number,
    favoriteId = wetWipes.id,
  ) => ({
    requestId,
    items: [{ favoriteId, quantity }],
  });

  test(
    "AC-A1, AC-L1: an added favourite appears on the list with the given quantity",
    async () => {
      await writeStore(withFavorites());
      const server = await connect({ storePath });
      const added = await call(server, "add_to_shopping_list", add("req-1", 2));
      expect(added.isError).toBe(false);
      expect(added.body).toMatchObject({
        requestId: "req-1",
        replayed: false,
        entries: [{ name: wetWipes.name, quantity: 2, action: "created" }],
      });
      expect(await quantityOf(wetWipes.id, server)).toEqual([2]);
    },
    TIMEOUT,
  );

  test(
    "AC-A8: an identical retry returns replayed: true and writes nothing",
    async () => {
      await writeStore(withFavorites());
      const server = await connect({ storePath });
      const first = await call(server, "add_to_shopping_list", add("req-1", 2));
      const afterFirst = await readFile(storePath);
      const retry = await call(server, "add_to_shopping_list", add("req-1", 2));
      expect(retry.body).toEqual({ ...first.body, replayed: true });
      expect(await readFile(storePath)).toEqual(afterFirst);
      expect(await quantityOf(wetWipes.id, server)).toEqual([2]);
    },
    TIMEOUT,
  );

  test(
    "AC-A2: a new requestId with the same items increases the quantity",
    async () => {
      await writeStore(withFavorites());
      const server = await connect({ storePath });
      await call(server, "add_to_shopping_list", add("req-1", 2));
      const second = await call(
        server,
        "add_to_shopping_list",
        add("req-2", 2),
      );
      expect(second.body).toMatchObject({
        replayed: false,
        entries: [{ quantity: 4, action: "merged" }],
      });
      expect(await quantityOf(wetWipes.id, server)).toEqual([4]);
    },
    TIMEOUT,
  );

  test(
    "AC-A9: the same requestId with different items is REQUEST_ID_CONFLICT and changes nothing",
    async () => {
      await writeStore(withFavorites());
      const server = await connect({ storePath });
      await call(server, "add_to_shopping_list", add("req-1", 2));
      const before = await readFile(storePath);
      const conflict = await call(
        server,
        "add_to_shopping_list",
        add("req-1", 3),
      );
      expect(conflict.isError).toBe(true);
      expect(conflict.body).toMatchObject({
        code: "REQUEST_ID_CONFLICT",
        message: expect.any(String),
      });
      expect(await readFile(storePath)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "AC-A10: an unknown favourite after a valid item fails with FAVORITE_NOT_FOUND and nothing is changed",
    async () => {
      const before = await writeStore(withFavorites());
      const server = await connect({ storePath });
      const result = await call(server, "add_to_shopping_list", {
        requestId: "req-1",
        items: [
          { favoriteId: wetWipes.id, quantity: 1 },
          { favoriteId: "0b1f6a52-3c4d-4e8f-9a01-ffffffffffff", quantity: 1 },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.body).toMatchObject({
        code: "FAVORITE_NOT_FOUND",
        message: expect.any(String),
        details: { itemIndex: 1 },
      });
      expect(await readFile(storePath)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "AC-A12 / VALIDATION_ERROR: malformed input is answered in the SPEC error format",
    async () => {
      const before = await writeStore(withFavorites());
      const server = await connect({ storePath });
      const result = await call(server, "add_to_shopping_list", {
        requestId: "req 1",
        items: [
          {
            product: { name: "Zahnseide", dmUrl: "https://www.dm.de/" },
            quantity: 1,
          },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.body.code).toBe("VALIDATION_ERROR");
      expect(
        result.body.details.issues.map((i: { path: string }) => i.path).sort(),
      ).toEqual(["items.0.product.dmUrl", "requestId"]);
      expect(await readFile(storePath)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "AC-L2: only open entries are returned, ordered by addedAt",
    async () => {
      const store = validStore(); // one open and one bought entry
      const earlier = {
        ...store.list[0]!,
        id: "e0000000-0000-4000-8000-0000000000aa",
        product: { name: "Spülmittel", dmUrl: dishSoap.dmUrl! },
        favoriteId: dishSoap.id,
        addedAt: "2026-01-15T07:00:00.000Z",
      };
      await writeStore({ ...store, list: [...store.list, earlier] });
      const server = await connect({ storePath });
      const list = await call(server, "get_shopping_list", {});
      expect(list.body.entries.map((e: { id: string }) => e.id)).toEqual([
        earlier.id,
        store.list[0]!.id,
      ]);
    },
    TIMEOUT,
  );

  test(
    "AC-L3: a missing store reads as an empty list and no file is created",
    async () => {
      const server = await connect({ storePath });
      expect(await call(server, "get_shopping_list", {})).toEqual({
        isError: false,
        body: { entries: [] },
      });
      expect(existsSync(storePath)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "AC-L4, AC-A15: a corrupt store is STORAGE_CORRUPT for reading and adding; the file stays unchanged",
    async () => {
      await writeFile(storePath, "{ not json");
      const before = await readFile(storePath);
      const server = await connect({ storePath });
      const list = await call(server, "get_shopping_list", {});
      const added = await call(server, "add_to_shopping_list", add("req-1", 1));
      expect(list).toMatchObject({
        isError: true,
        body: { code: "STORAGE_CORRUPT" },
      });
      expect(added).toMatchObject({
        isError: true,
        body: { code: "STORAGE_CORRUPT" },
      });
      expect(await readFile(storePath)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "[protocol] get_shopping_list rejects unexpected arguments with VALIDATION_ERROR",
    async () => {
      const server = await connect({ storePath });
      const result = await call(server, "get_shopping_list", {
        status: "bought",
      });
      expect(result).toMatchObject({
        isError: true,
        body: { code: "VALIDATION_ERROR" },
      });
    },
    TIMEOUT,
  );
});
