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

describe("callTool error handling", () => {
  test("an unexpected exception becomes INTERNAL_ERROR (no success) and is logged, not printed", async () => {
    const logs: string[] = [];
    const result = await callTool(
      "add_to_shopping_list",
      { requestId: "req-1", items: [{ favoriteId: "f-1", quantity: 1 }] },
      deps(
        {
          update: async () => {
            throw new Error("disk exploded");
          },
        },
        logs,
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(logs.join("\n")).toContain("disk exploded");
  });

  test("an unknown tool name is a protocol error (McpError), not a tool result", async () => {
    await expect(
      callTool("save_favorite", {}, deps({}, [])),
    ).rejects.toBeInstanceOf(McpError);
  });
});
