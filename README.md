# Familien-Einkaufshelfer (MCP)

> **Draft README** – describes the planned v1. Before publishing, tick the status list below and remove or move to *Roadmap* everything that is not actually built and verified.

An MCP server that turns everyday shopping requests into a clean shopping list: it matches requested items to your family's saved favourites, reports ambiguities instead of guessing, and keeps the list free of accidental duplicates.

> "We need dish soap again, two packs of the usual wet wipes – and a different toothpaste this time."

The AI client (e.g. Claude) interprets the free-form sentence and calls this server's tools with **structured input** (item term, quantity, request ID). The rules behind the tools are deterministic, so the parts that must be correct are covered by automated tests.

For new products, the AI client also uses **dm's public MCP server** to search the dm assortment. The two servers are combined **by the AI client**: Claude searches at dm and passes the selected product to this server. This server never calls dm itself.

## Status

- [ ] Vertical slice: resolve favourite → add to list → show list → tests pass
- [ ] MCP tools implemented (`get_favorites`, `resolve_items`, `get_shopping_list`, `add_to_shopping_list`, `save_favorite`)
- [ ] Shared local storage for MCP server and UI
- [ ] Next.js UI: favourites, shopping list, mark as bought / remove
- [ ] Vitest unit tests for matching, merging, idempotency, error handling
- [ ] Playwright E2E tests for the UI
- [ ] `.mcp.json` with this server and dm's MCP server
- [ ] Stop hook verified with a deliberately failing test
- [ ] Manual end-to-end run with dm's MCP server documented

## How it works

```
 You (voice / text)
        │
        ▼
 AI client (Claude) ── interprets language, orchestrates both servers
     │                                   │
     ▼                                   ▼
 einkaufshelfer MCP server          dm MCP server (public, read-only)
  • get_favorites                    • product search
  • resolve_items                    • product details
  • get_shopping_list
  • add_to_shopping_list
  • save_favorite
     │
     ▼
 Storage (local JSON, shared) ◄──── Next.js UI: favourites & shopping list
```

**Example requests**

| Request | What happens |
|---|---|
| "Two packs of the usual wet wipes" | `resolve_items` finds exactly one favourite with that alias → `add_to_shopping_list` adds it with quantity 2. |
| "The usual toothpaste" | Resolved to the saved favourite. |
| "Toothpaste" (two toothpastes saved) | `resolve_items` returns `ambiguous` with both candidates → Claude asks back. |
| "A different toothpaste this time" | Claude does **not** call `resolve_items` for the old favourite; it searches alternatives via dm's MCP server. You pick one, it is added to the list and, if you like, saved with `save_favorite`. |
| "Dish soap" (already on the list) | Quantity is increased instead of creating a second entry. |

## MCP tools

| Tool | Input | Behaviour |
|---|---|---|
| `get_favorites` | – | Saved favourites with category, aliases (e.g. "the usual wet wipes") and dm product link. |
| `resolve_items` | list of `{ term, quantity }` | Per item: `resolved` (one favourite), `ambiguous` (candidates) or `unknown`. Never picks at random. |
| `get_shopping_list` | – | Current shopping list. |
| `add_to_shopping_list` | `requestId`, list of `{ favoriteId, quantity }` | Adds items; merges quantities for items already on the list. Idempotent per `requestId`. |
| `save_favorite` | product data (name, category, aliases, dm link) | Stores a new favourite. |

**Duplicate rule**

- The **same request** is retried (same `requestId`) → the list stays unchanged.
- A **new request** for the same product (new `requestId`) → the quantity increases.

Marking items as bought or removing them happens in the UI in v1.

## Storage

The MCP server and the UI share one local JSON file behind a small storage interface. Writes are serialized and atomic (write to a temp file, then rename), so concurrent changes from UI and MCP server cannot overwrite each other. Another adapter (e.g. an external list service) can be added later without changing the core logic.

## Tech stack

TypeScript · [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · Next.js · React · Vitest · Playwright · Claude Code (CLAUDE.md, hooks)

## Project structure

```
src/
  core/        # matching rules, merging, idempotency (pure functions)
  store/       # storage interface + local JSON implementation
  mcp/         # MCP server exposing the tools (stdio)
app/           # Next.js UI
data/          # fictional sample favourites
tests/         # Vitest unit tests (fixtures only, no live calls)
e2e/           # Playwright tests
SPEC.md        # requirements and acceptance criteria
CLAUDE.md      # project context and development rules for Claude Code
.claude/       # Claude Code settings incl. Stop hook
.mcp.json      # MCP servers for this project
```

## Getting started

Requirements: Node.js 20+

```bash
npm install
npm run dev          # UI on http://localhost:3000
npm run mcp          # MCP server (stdio)
```

### Use it with Claude Code

```bash
claude mcp add einkaufshelfer -- npx tsx src/mcp/server.ts
claude mcp add --transport http dm https://mcp.dm.de/mcp
```

Then try: *"Add two packs of the usual wet wipes and a different toothpaste to the shopping list."*

## Tests

```bash
npm run typecheck
npm test             # Vitest
npm run test:e2e     # Playwright
```

Automated tests use fixed sample data and never call dm's live server. The live integration is checked separately with a documented manual run (see *Manual check*).

| Test case | Expected behaviour |
|---|---|
| "Two packs of the usual wet wipes" | Resolved favourite, quantity 2 |
| "The usual toothpaste" | Resolved favourite |
| "Toothpaste" with two matching favourites | `ambiguous` with both candidates |
| Unknown product | `unknown` |
| Item already on the list, new request | Quantity merged |
| Same request retried (same `requestId`) | List unchanged |
| Storage unavailable / write fails | Clear error, no success message |
| UI: add and display | Items appear with correct quantities |
| UI: mark as bought | Item disappears from the open list |

### Manual check

Documented example run in Claude Code with both servers connected: request → dm search → selection → item on the list → visible in the UI.

## Agentic workflow

- **Spec first:** requirements and acceptance criteria in `SPEC.md`; reviews are done against the spec.
- **`CLAUDE.md`:** commands, conventions and gotchas the agent cannot infer from the code.
- **Stop hook:** runs typecheck and tests when the agent tries to finish; on failure it exits with code 2, so Claude Code sends the agent back to fix the problem. Verified once with a deliberately failing test.
- **Human review:** changes are reviewed functionally and in code before committing.

## Privacy & data

- `data/` contains **fictional sample data only**.
- No API keys or secrets are needed or stored.
- dm's MCP server is a public, read-only interface. Please follow dm's terms of use and keep request volumes low.

## Roadmap

- Suggest items that will run out soon, based on average purchase intervals
- MCP tool for marking items as bought
- Optional sync with an external list service via a second storage adapter
- Optional built-in voice input

## Disclaimer

Private learning and portfolio project. Not affiliated with or endorsed by dm-drogerie markt.

