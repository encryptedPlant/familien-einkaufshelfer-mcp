// Direct handler tests for paths that cannot be provoked through a real
// server process. The MCP behaviour itself is tested in server.test.ts.

import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";
import { emptyStore } from "../../src/core/store-schema";
import { callTool, type ToolDeps } from "../../src/mcp/tools";
import type { Store } from "../../src/store/store";

function deps(store: Partial<Store>, logs: string[]): ToolDeps {
  return {
    store: {
      path: "/virtual/store.json",
      read: async () => ({ ok: true, value: emptyStore() }),
      update: async () => {
        throw new Error("update not expected");
      },
      ...store,
    },
    now: () => "2026-02-10T09:00:00.000Z",
    newId: () => "a0000000-0000-4000-8000-000000000001",
    log: (message) => logs.push(message),
  };
}

const throwing = async (): Promise<never> => {
  throw new Error("disk exploded");
};

function message(result: { structuredContent?: unknown }): string {
  return String((result.structuredContent as { message?: string }).message);
}

describe("callTool error handling", () => {
  test("add_to_shopping_list: an unexpected exception becomes INTERNAL_ERROR and suggests retrying with the same requestId and items", async () => {
    const logs: string[] = [];
    const result = await callTool(
      "add_to_shopping_list",
      { requestId: "req-1", items: [{ favoriteId: "f-1", quantity: 1 }] },
      deps({ update: throwing }, logs),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(message(result)).toMatch(/same requestId/);
    expect(message(result)).toMatch(/same items/);
    expect(message(result)).not.toContain("disk exploded");
    expect(logs.join("\n")).toContain("disk exploded");
  });

  test("save_favorite: an unexpected exception says the outcome is unclear, points to get_favorites and promises no safe retry", async () => {
    const logs: string[] = [];
    const result = await callTool(
      "save_favorite",
      { name: "Teelichter", category: "Haushalt" },
      deps({ update: throwing }, logs),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(message(result)).toMatch(/unclear/i);
    expect(message(result)).toMatch(/get_favorites/);
    expect(message(result)).toMatch(/do not .*save_favorite/i);
    expect(message(result)).not.toMatch(/requestId/);
    expect(message(result)).not.toMatch(/safe/i);
    expect(logs.join("\n")).toContain("disk exploded");
  });

  test.each([
    ["resolve_items", { items: [{ term: "Spüli" }] }],
    ["get_shopping_list", {}],
    ["get_favorites", {}],
  ])(
    "%s (read-only): an unexpected exception becomes INTERNAL_ERROR without any requestId or retry hint",
    async (name, args) => {
      const result = await callTool(name, args, deps({ read: throwing }, []));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        code: "INTERNAL_ERROR",
      });
      expect(message(result)).not.toMatch(/requestId/);
      expect(message(result)).not.toMatch(/retry|save/i);
    },
  );

  test("an unknown tool name is a protocol error (McpError), not a tool result", async () => {
    await expect(
      callTool("add_to_cart", {}, deps({}, [])),
    ).rejects.toBeInstanceOf(McpError);
  });
});
