// Starts the MCP server on stdio. stdout carries only MCP messages; all
// diagnostics, including the absolute store path, go to stderr.

import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJsonFileStore } from "../store/json-file-store";
import { resolveStorePath } from "../store/path";
import { createMcpServer } from "./server";

function log(message: string): void {
  process.stderr.write(`[einkaufshelfer mcp] ${message}\n`);
}

// Keep stdout clean even if a dependency logs with console.log/info/debug.
console.log =
  console.info =
  console.debug =
    (...args: unknown[]) => log(args.map(String).join(" "));

const storePath = resolveStorePath();
const store = createJsonFileStore(storePath, { log });
const server = createMcpServer({
  store,
  now: () => new Date().toISOString(),
  newId: randomUUID,
  log,
});

let closing = false;
async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  log(`shutting down (${reason})`);
  try {
    await server.close();
  } catch (error) {
    log(`error while closing: ${String(error)}`);
  }
}

// The client closing the connection ends stdin; then the process can exit
// on its own once pending work (e.g. a write) has finished.
process.stdin.once("end", () => void shutdown("stdin closed"));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}

await server.connect(new StdioServerTransport());
log(`started; store: ${storePath}`);
