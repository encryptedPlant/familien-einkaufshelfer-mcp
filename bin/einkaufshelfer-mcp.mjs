#!/usr/bin/env node
// Entry point of the einkaufshelfer MCP server (stdio).
//
// Started directly with node (`node bin/einkaufshelfer-mcp.mjs`), not via
// npm/npx. It registers the locally installed tsx loader – resolved relative
// to this file, so the working directory does not matter and nothing is
// downloaded – and then loads the TypeScript server.

import { register } from "tsx/esm/api";

register();
await import("../src/mcp/main.ts");
