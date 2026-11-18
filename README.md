# Familien-Einkaufshelfer (MCP)

> **Draft README** – describes the planned v1. The *Status* section is the source of truth for what is actually built and verified; everything else in this README is the plan unless marked otherwise.

An MCP server that turns everyday shopping requests into a clean shopping list: it matches requested items to your family's saved favourites, reports ambiguities instead of guessing, and keeps the list free of accidental duplicates.

> "We need dish soap again, two packs of the usual wet wipes – and a different toothpaste this time."

The AI client (e.g. Claude) interprets the free-form sentence and calls this server's tools with **structured input** (item term, quantity, request ID). The rules behind the tools are deterministic, so the parts that must be correct are covered by automated tests.

For new products, the AI client also uses **dm's public MCP server** to search the dm assortment. The two servers are combined **by the AI client**: Claude searches at dm and passes the selected product to this server. This server never calls dm itself.

## Status

Project scaffold plus the phase 1 core logic as pure, unit-tested functions: validation, normalisation, product identity, matching (part a) and merging, rejection of faulty requests, payload hash and replay decision (part b). **Nothing is usable yet:** there are no MCP tools, no storage and no shopping UI. The JSON file storage comes next.

Done and verified:

- [x] Tooling installed and configured: TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Zod, Prettier, Vitest, MCP TypeScript SDK. `npm run typecheck` and `npm run format:check` pass.
- [x] Next.js placeholder start page. The Playwright smoke test (`npm run test:e2e`, Chromium) passes.
- [x] Stop hook script checked by calling it directly: exit 0 when green; exit 2 with a readable report for a failing Vitest test, a type error and missing tools; the loop guard releases after 3 blocked stops and reports that explicitly.
- [x] Stop hook verified in a real Claude Code turn: a deliberately failing Vitest test blocked the end of the turn and the failure report reached Claude; after removing the test the next stop was not blocked (see *Agentic workflow*).
- [x] Core part (a) in `src/core/` (pure, no I/O), covered by 110 Vitest unit tests in `tests/core/`:
  - input validation for `resolve_items` and `add_to_shopping_list` (SPEC §6.1, §6.2), incl. trimming and dm URL normalisation
  - text normalisation (§4.1) and dm URL normalisation (§4.2)
  - product identity incl. mixed and contradicting identifiers (§4.2)
  - matching with alias → name → category priority; results `resolved`, `ambiguous` or `unknown` (§4.3)

  The first 96 tests failed before the implementation (all with "not implemented", no import or configuration errors); the 12 tests added for the dm start-page rule (SPEC §4.2) failed before that rule was implemented. Deliberately broken variants of the code (8 cases, e.g. name before alias, no NFC, no URL normalisation, no conflict detection) each made the corresponding tests fail.
- [x] Core part (b) in `src/core/` (pure, no I/O), covered by 37 further Vitest unit tests (147 in total):
  - `addToShoppingList(store, input, { now, newId })`: applies items in input order to the open entries, merges the same product (also within one request), increases quantities, fills missing article number / URL without overwriting, never merges into bought entries (§4.4)
  - rejects the whole request on `FAVORITE_NOT_FOUND`, `QUANTITY_LIMIT` or `PRODUCT_IDENTITY_CONFLICT`, even after valid items; returns no state and records nothing, so a corrected retry with the same `requestId` is processed normally
  - canonical JSON (sorted keys, array order kept) and SHA-256 payload hash over the validated items; `favoriteId` is hashed as given (§4.5)
  - known `requestId` is checked before any favourite is resolved: same payload → stored result with `replayed: true`, different payload or order → `REQUEST_ID_CONFLICT`

  The 37 new tests failed before the implementation (all with "not implemented", no setup errors). Store and input are deep-frozen in every test and compared after the call. 8 deliberately broken variants (e.g. merging into bought entries, hash depending on favourites, limit off by one, ignoring conflicts, order-insensitive hash) each made the corresponding tests fail.

Partly covered (pure functions only, not yet through MCP tools or storage):

- `resolve_items` criteria AC-R1–R5 and AC-R7 are tested on the core functions; the MCP tool does not exist yet. AC-R6 ("store unchanged") is only shown for the inputs of the pure function.
- `add_to_shopping_list` criteria AC-A1–A13 are tested on the core functions. Not yet covered: the MCP tool, that nothing is *written* on errors, and persistence of processed requests (atomic write, replay after a restart). AC-A14, AC-A15 and the storage criteria (§6.4) belong to the storage package.

Known `npm audit` findings (accepted for now):

- 5 findings rated *high*, all caused by one advisory: ReDoS in `picomatch` ([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)), pulled in via `vitest → vite → tinyglobby / fdir`. Affects dev tooling only; the glob patterns come from this project's own config.
- `npm audit fix` would downgrade Vitest to 3.1.4 (semver-major, older line), so it was not applied. Re-check when Vitest or picomatch publish a fix.

Open:

- [ ] Vertical slice: resolve favourite → add to list → show list → tests pass
- [ ] MCP tools implemented (`get_favorites`, `resolve_items`, `get_shopping_list`, `add_to_shopping_list`, `save_favorite`)
- [ ] Shared local storage for MCP server and UI
- [ ] Next.js UI: favourites, shopping list, mark as bought / remove
- [ ] Storage integration tests (SPEC §6.4)
- [ ] Playwright E2E tests for the UI beyond the smoke test
- [ ] `.mcp.json` with this server and dm's MCP server
- [ ] Manual end-to-end run with dm's MCP server documented
- [ ] ESLint and CI (deliberately postponed)

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

TypeScript · Zod · [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · Next.js · React · Prettier · Vitest · Playwright · Claude Code (CLAUDE.md, hooks)

Next.js and Playwright are set up ahead of phase 3 (SPEC §2) so the scaffold is complete; so far they only serve a placeholder page and a smoke test.

## Project structure

```
src/
  core/                  # pure functions: validation, normalisation, identity, matching,
                         #   merging, payload hash, replay decision
  store/                 # (planned) storage interface + local JSON implementation
  mcp/                   # (planned) MCP server exposing the tools (stdio)
app/                     # Next.js UI – currently a placeholder start page
data/                    # (planned) fictional sample favourites; local store is git-ignored
tests/                   # Vitest tests, *.test.ts
  core/                  #   unit tests for src/core
  fixtures/              #   fixed, fictional sample data
e2e/                     # Playwright tests, *.spec.ts – smoke test
SPEC.md                  # requirements and acceptance criteria
CLAUDE.md                # project context and development rules for Claude Code
.claude/settings.json    # Claude Code settings: Stop hook
.claude/hooks/check.mjs  # Stop hook script (typecheck + Vitest)
.mcp.json                # (planned) MCP servers for this project
```

## Getting started

Requirements: Node.js 22.12+, 24 or 26+ (developed with 26.13.1) and npm.

```bash
npm install
npx playwright install chromium   # browser for the E2E tests
npm run dev                       # placeholder UI on http://localhost:3000
```

The MCP server does not exist yet; `npm run mcp` will be added with it.

### Use it with Claude Code (planned)

```bash
claude mcp add einkaufshelfer -- npx tsx src/mcp/server.ts
claude mcp add --transport http dm https://mcp.dm.de/mcp
```

Then try: *"Add two packs of the usual wet wipes and a different toothpaste to the shopping list."*

## Tests

```bash
npm run typecheck    # tsc --noEmit
npm test             # Vitest, single run: vitest run --passWithNoTests
npm run test:e2e     # Playwright, starts `npm run dev` itself
npm run format:check # Prettier check (Markdown is excluded)
npm run format       # Prettier write
```

Vitest only picks up `tests/**/*.test.ts`; Playwright only `e2e/**/*.spec.ts`, so `npm test` never starts a browser. `--passWithNoTests` only covers the case that no test files exist; failing tests still fail the run.

Automated tests use fixed, fictional sample data and never call dm's live server. The live integration is checked separately with a documented manual run (see *Manual check*). Test names start with the SPEC acceptance criterion they cover (e.g. `AC-R3: …`); "(… part)" marks criteria that are only partly covered so far.

| Test case | Expected behaviour | Status |
|---|---|---|
| "Two packs of the usual wet wipes" | Resolved favourite, quantity 2 | core unit test (AC-R1); adding to the list open |
| "The usual toothpaste" | Resolved favourite | same alias rule as AC-R1, no separate test |
| "Toothpaste" with two matching favourites | `ambiguous` with both candidates | core unit test (AC-R3) |
| Unknown product | `unknown` | core unit test (AC-R5) |
| Item already on the list, new request | Quantity merged | core unit test (AC-A2) |
| Same request retried (same `requestId`) | List unchanged | core unit test (AC-A8); replay after a restart open (storage) |
| Storage unavailable / write fails | Clear error, no success message | planned |
| UI: add and display | Items appear with correct quantities | planned |
| UI: mark as bought | Item disappears from the open list | planned |

### Manual check

Documented example run in Claude Code with both servers connected: request → dm search → selection → item on the list → visible in the UI.

## Agentic workflow

- **Spec first:** requirements and acceptance criteria in `SPEC.md`; reviews are done against the spec.
- **`CLAUDE.md`:** commands, conventions and gotchas the agent cannot infer from the code.
- **Stop hook** (`.claude/hooks/check.mjs`, Node, no shell): runs typecheck and Vitest when the agent tries to finish, independent of the working directory. On failure, or if a check cannot be started, it exits with code 2 and a readable report, so Claude Code sends the agent back to fix the problem. A loop guard lets the turn end after 3 blocked stops in one turn and then shows an explicit "LOOP GUARD … NOT green" message. If no Vitest tests exist, it says so instead of reporting a plain pass.
  - Verified: direct calls of the script (green, failing test, type error, missing tools, loop guard).
  - Verified in a real Claude Code turn (Claude desktop app, Windows): with a temporary failing test in `tests/hook-check.test.ts`, the automatically triggered hook blocked the end of the turn and returned the Vitest failure report to Claude ("blocked stop 1 of 3"). After the test was removed, the next stop was not blocked.
  - Not verified in a real turn: the loop guard (only checked by calling the script directly).

  To re-check the integration:
  1. Create `tests/hook-check.test.ts` containing a failing assertion, e.g. `expect(1 + 1).toBe(3)`.
  2. Ask Claude for something trivial. When it tries to finish, the turn must not end; Claude must receive the Vitest failure report.
  3. Delete the test file, let the turn finish, and confirm the hook passes again.
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

