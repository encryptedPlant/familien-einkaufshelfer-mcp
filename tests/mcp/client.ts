// Starts the real MCP server as a separate stdio process via the SDK client.

import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT } from "../store/processes";

export const ENTRY = join(ROOT, "bin", "einkaufshelfer-mcp.mjs");

export type Connection = {
  readonly client: Client;
  stderr(): string;
  close(): Promise<void>;
};

const open = new Set<Connection>();

export async function connect(options: {
  storePath: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}): Promise<Connection> {
  const transport = new StdioClientTransport({
    command: options.command ?? process.execPath,
    args: options.args ?? [ENTRY],
    cwd: options.cwd ?? tmpdir(),
    env: {
      ...getDefaultEnvironment(),
      ...options.env,
      EINKAUFSHELFER_DATA_FILE: options.storePath,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const client = new Client({ name: "einkaufshelfer-test", version: "0.0.0" });
  await client.connect(transport);
  const connection: Connection = {
    client,
    stderr: () => stderr,
    close: async () => {
      open.delete(connection);
      await client.close();
    },
  };
  open.add(connection);
  return connection;
}

export async function closeAll(): Promise<void> {
  await Promise.all([...open].map((c) => c.close()));
}

export type ToolCall = {
  readonly isError: boolean;
  /** The JSON body from the text content (result or error object). */
  readonly body: any;
};

export async function call(
  connection: Connection,
  name: string,
  args?: Record<string, unknown>,
): Promise<ToolCall> {
  const result = await connection.client.callTool({
    name,
    ...(args !== undefined ? { arguments: args } : {}),
  });
  const content = result.content as { type: string; text?: string }[];
  expect(content[0]?.type).toBe("text");
  const body = JSON.parse(content[0]?.text ?? "null");
  if (result.structuredContent !== undefined) {
    expect(result.structuredContent).toEqual(body);
  }
  return { isError: result.isError === true, body };
}
