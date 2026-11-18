// MCP server wiring with the SDK's Server class.
//
// The tool handlers are registered on the low-level Server (the class that
// McpServer is built on) so that invalid input reaches our own validation
// and is answered in the SPEC error format. McpServer would validate first
// and answer with a plain-text error instead.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callTool, type ToolDeps, TOOLS } from "./tools";

export const SERVER_INFO = { name: "einkaufshelfer", version: "0.0.0" };

export function createMcpServer(deps: ToolDeps): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...TOOLS],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callTool(request.params.name, request.params.arguments, deps),
  );
  return server;
}
