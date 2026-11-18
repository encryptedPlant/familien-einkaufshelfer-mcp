# Familien-Einkaufshelfer (MCP)

> **Draft README** – describes the planned v1. The *Status* section is the source of truth for what is actually built and verified; everything else in this README is the plan unless marked otherwise.

An MCP server that turns everyday shopping requests into a clean shopping list: it matches requested items to your family's saved favourites, reports ambiguities instead of guessing, and keeps the list free of accidental duplicates.

> "We need dish soap again, two packs of the usual wet wipes – and a different toothpaste this time."

The AI client (e.g. Claude) interprets the free-form sentence and calls this server's tools with **structured input** (item term, quantity, request ID). The rules behind the tools are deterministic, so the parts that must be correct are covered by automated tests.

For new products, the AI client also uses **dm's public MCP server** to search the dm assortment. The two servers are combined **by the AI client**: Claude searches at dm and passes the selected product to this server. This server never calls dm itself.

## Status

Project scaffold, the phase 1 core logic as pure, unit-tested functions (validation, normalisation, product identity, matching; merging, rejection of faulty requests, payload hash, replay decision) , the JSON file storage with cross-process locking, and a first MCP server (stdio) with `resolve_items`, `add_to_shopping_list` and `get_shopping_list`. The server is tested automatically through the MCP SDK client; **a run in Claude Code is still open** (see *Use it with Claude Code*). Not there yet: `get_favorites`, `save_favorite`, the dm connection and the shopping UI.

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

- [x] JSON file storage in `src/store/` (SPEC §4.6, assumptions A9–A12), covered by 84 further tests (231 in total):
  - `resolveStorePath()`: one shared path function; `<project root>/data/store.json` or `EINKAUFSHELFER_DATA_FILE` (relative to the project root), independent of the working directory
  - `Store` interface with `read()` and `update(fn)`; JSON adapter `createJsonFileStore(path)`: full StoreFile validation incl. consistency rules (missing file → empty store, never created on read; invalid content or version → `STORAGE_CORRUPT`, file untouched; I/O errors → `STORAGE_UNAVAILABLE`)
  - `update(fn)` under an exclusive cross-process lock (`proper-lockfile`, lock wait 5 s, stale after 4 s, refreshed nominally every 1 s), unique temp file in the same directory, rename retried on `EPERM`/`EBUSY` every 50 ms for up to 2 s, the store file is never deleted, a cleanup failure is logged without hiding the original error, the lock is always released unless it was lost
  - the lock state is checked before writing and before every rename attempt: once a lock loss is known, no further rename starts, the temp file is removed and the result is `STORAGE_UNAVAILABLE`; a rename that has already started cannot be undone, so arbitrary process pauses are not fully covered (A9)
  - `addToShoppingListInStore()`: list change and processed request in one write; business errors and replays write nothing; success only after the write
  - `data/sample-favorites.json` (fictional) and `npm run seed`, which only fills a missing or empty store and uses the same store logic and lock

  Concurrency and crashes are tested with separate OS processes synchronised by messages (no sleeps): two writers, the same request from two processes, a replay after a restart, different working directories, a lock held beyond the timeout, an actively refreshed lock that is not stolen, and a killed lock holder whose stale lock is taken over. I/O errors are simulated through an injected file-system adapter. All tests use their own temp directories. The 81 new tests failed before the implementation (all due to "not implemented", 9 of them inside worker processes; no setup errors). 11 deliberately broken variants were tried: 10 made the corresponding tests fail; retrying non-`ELOCKED` lock errors until the timeout went unnoticed (same result, only later; such errors cannot be simulated without bypassing the library). 3 regression tests for a lock lost during the write (detected while the temp file is written, or after a failed rename; also with a failing cleanup) trigger a real takeover of the lock directory, failed with the earlier code (it reported success) and pass now.

- [x] MCP server (`src/mcp/`, entry `bin/einkaufshelfer-mcp.mjs`, `npm run mcp`), covered by 23 further tests (254 in total):
  - stdio transport; stdout carries only MCP messages; diagnostics and the absolute store path go to stderr; the server exits cleanly when the client closes stdin
  - started directly with `node` and a local entry point that registers the installed tsx loader relative to its own location: no npm/npx, no downloads, independent of the working directory
  - `resolve_items` (read-only), `add_to_shopping_list` (requestId check, merge and write in one locked `update`; IDs and timestamps generated in the server layer), `get_shopping_list` (open entries by `addedAt`, never creates the file); tool descriptions contain the client guidance for `ambiguous`/`unknown` and the `requestId` rules; annotations `readOnlyHint`, `idempotentHint`, `destructiveHint: false`, `openWorldHint: false`
  - errors as tool results with `isError: true` and a JSON body `{ code, message, details }`, also for invalid input
  - integration tests start the real server as a separate process through the SDK client (`StdioClientTransport`), each with its own temp store, also from another working directory and with the exact command from `.mcp.json`

  The new tests failed before the implementation because of missing behaviour (empty tool list or "not implemented"); server start, connection and shutdown already worked, so one protocol test passed early. 7 deliberately broken variants (e.g. error without `isError`, diagnostics on stdout, request applied twice, wrong annotation) each made the corresponding tests fail.

Covered through the MCP tools, automated (not yet in a Claude Code run):

- `resolve_items`: AC-R1, AC-R3, AC-R5, AC-R6, AC-R7 via MCP; AC-R2 and AC-R4 on the core functions.
- `add_to_shopping_list`: AC-A1, AC-A2, AC-A8, AC-A9, AC-A10, AC-A12, AC-A15 via MCP; the others on the core functions and the JSON store (AC-A14 storage tests).
- `get_shopping_list`: AC-L1–L4 via MCP.
- The UI does not use the store yet; whether the location-based path lookup works when Next.js bundles the code (A8) is open.

Known `npm audit` findings (accepted for now):

- 5 findings rated *high*, all caused by one advisory: ReDoS in `picomatch` ([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)), pulled in via `vitest → vite → tinyglobby / fdir`. Affects dev tooling only; the glob patterns come from this project's own config.
- `npm audit fix` would downgrade Vitest to 3.1.4 (semver-major, older line), so it was not applied. Re-check when Vitest or picomatch publish a fix.
- Unchanged after adding `proper-lockfile` and `tsx`. Note: `proper-lockfile` 4.1.2 has had no release since 2022; npm also reports that the `postinstall` script of `esbuild` (used by `tsx`) is not approved – `tsx` works without it.

Open:

- [ ] Vertical slice: resolve favourite → add to list → show list → tests pass
- [ ] Manual run of `resolve_items`, `add_to_shopping_list` and `get_shopping_list` in Claude Code (steps below)
- [ ] MCP tools `get_favorites` and `save_favorite` (phase 2)
- [ ] Next.js UI: favourites, shopping list, mark as bought / remove – using the shared store (A8)
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

| Tool | Status | Input | Behaviour |
|---|---|---|---|
| `resolve_items` | implemented | list of `{ term, quantity }` | Per item: `resolved` (one favourite), `ambiguous` (candidates) or `unknown`. Never picks at random. Read-only. |
| `add_to_shopping_list` | implemented | `requestId`, list of `{ favoriteId, quantity }` or `{ product, quantity }` | Adds items; merges quantities for items already on the list. Idempotent per `requestId`. |
| `get_shopping_list` | implemented | – | Open entries, oldest first. Read-only. |
| `get_favorites` | planned | – | Saved favourites with category, aliases (e.g. "the usual wet wipes") and dm product link. |
| `save_favorite` | planned | product data (name, category, aliases, dm link) | Stores a new favourite. |

Errors are tool results with `isError: true` and a JSON body `{ "code", "message", "details"? }` (SPEC §4.7). Unexpected internal exceptions return `INTERNAL_ERROR`: no success is claimed and details go only to stderr, but it is not guaranteed that nothing was changed. The tool descriptions tell the client to ask back on `ambiguous`/`unknown` and explain the `requestId` rules; the server cannot enforce how the client behaves.

**Duplicate rule**

- The **same request** is retried (same `requestId`) → the list stays unchanged.
- A **new request** for the same product (new `requestId`) → the quantity increases.

Marking items as bought or removing them happens in the UI in v1.

## Storage

The MCP server and the UI are to share one local JSON file (`data/store.json`, git-ignored; override with `EINKAUFSHELFER_DATA_FILE`) behind a small storage interface (`read()`, `update(fn)`). Each update reads, changes and writes under an exclusive cross-process lock (`proper-lockfile`, lock directory `<store>.lock`); the new content goes to a temp file in the same directory and replaces the store file by rename, so concurrent changes cannot overwrite each other and a failed write leaves the previous file intact. A lock left behind by a crashed process is taken over after 4 s; an active lock never is (SPEC A9 lists the limits). Another adapter (e.g. an external list service) can be added later without changing the core logic. So far only tests and `npm run seed` use the storage.

## Tech stack

TypeScript · Zod · [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · Next.js · React · Prettier · Vitest · Playwright · Claude Code (CLAUDE.md, hooks)

Next.js and Playwright are set up ahead of phase 3 (SPEC §2) so the scaffold is complete; so far they only serve a placeholder page and a smoke test.

## Project structure

```
src/
  core/                  # pure functions: validation, normalisation, identity, matching,
                         #   merging, payload hash, replay decision
  store/                 # storage interface, store path, JSON file store with lock, seed
  mcp/                   # MCP server (stdio): tools, server wiring, start-up
bin/einkaufshelfer-mcp.mjs  # entry point: node + local tsx loader, cwd-independent
app/                     # Next.js UI – currently a placeholder start page
data/                    # sample-favorites.json (fictional, committed); store.json and
                         #   demo-store.json are git-ignored
scripts/                 # seed.ts (`npm run seed`)
tests/                   # Vitest tests, *.test.ts
  core/                  #   unit tests for src/core
  store/                 #   storage tests incl. separate worker processes (worker.ts)
  mcp/                   #   MCP integration tests (real server process via the SDK client)
  fixtures/              #   fixed, fictional sample data
e2e/                     # Playwright tests, *.spec.ts – smoke test
SPEC.md                  # requirements and acceptance criteria
CLAUDE.md                # project context and development rules for Claude Code
.claude/settings.json    # Claude Code settings: Stop hook
.claude/hooks/check.mjs  # Stop hook script (typecheck + Vitest)
.mcp.json                # project MCP config: einkaufshelfer (demo store); dm planned
```

## Getting started

Requirements: Node.js 22.12+, 24 or 26+ (developed with 26.13.1) and npm.

```bash
npm install
npx playwright install chromium   # browser for the E2E tests
npm run dev                       # placeholder UI on http://localhost:3000
npm run seed                      # optional: fictional sample favourites into an empty store
```

```bash
npm run mcp                       # MCP server on stdio (normally started by the MCP client)
```

### Use it with Claude Code

The project's `.mcp.json` starts the server with `node "${CLAUDE_PROJECT_DIR:-.}/bin/einkaufshelfer-mcp.mjs"` (no absolute paths; Claude Code runs project servers in the project directory, the entry point itself does not depend on the working directory). For now it points to a separate **demo store** `data/demo-store.json` (git-ignored) with the fictional sample favourites. dm's MCP server is not configured yet.

1. Create the demo store once (PowerShell, then bash):

   ```powershell
   $env:EINKAUFSHELFER_DATA_FILE = "data/demo-store.json"; npm run seed; Remove-Item Env:EINKAUFSHELFER_DATA_FILE
   ```

   ```bash
   EINKAUFSHELFER_DATA_FILE=data/demo-store.json npm run seed
   ```

2. Start a **new** Claude Code session in the project folder (a running session does not pick up a newly added `.mcp.json`). Claude Code asks once whether to use the project server `einkaufshelfer`; approve it. `node` must be on the PATH of Claude Code.
3. Check the connection with `/mcp` in the session (or `claude mcp list` / `claude mcp get einkaufshelfer` in a terminal): `einkaufshelfer` should be connected with three tools. The server writes its store path to stderr.

**Manual check (open, not yet run):**

| Step | Ask Claude | Expected |
|---|---|---|
| 1 | "Wir brauchen zwei Packungen der üblichen Feuchttücher." | `resolve_items` → `resolved` (Feuchttücher sensitiv); `add_to_shopping_list` with a new requestId, quantity 2 |
| 2 | "Wiederhole genau diesen Aufruf technisch mit derselben requestId." | `replayed: true`, list still shows 2 |
| 3 | "Wir brauchen noch einmal zwei Packungen der üblichen Feuchttücher." | new requestId, entry merged, quantity 4 |
| 4 | "Bitte etwas Zahnpflege auf die Liste." | `resolve_items` → `ambiguous` (Zahnpasta Minze / Kräuter); Claude asks back; `get_shopping_list` shows nothing new until you choose |
| 5 | "Was steht auf der Einkaufsliste?" | `get_shopping_list` with the open entries |

Reset the demo by deleting `data/demo-store.json` and seeding again. Automated SDK tests do not replace this run.

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
| "Two packs of the usual wet wipes" | Resolved favourite, quantity 2 | core and MCP tests (AC-R1, AC-A1); Claude Code run open |
| "The usual toothpaste" | Resolved favourite | same alias rule as AC-R1, no separate test |
| "Toothpaste" with two matching favourites | `ambiguous` with both candidates | core unit test (AC-R3) |
| Unknown product | `unknown` | core unit test (AC-R5) |
| Item already on the list, new request | Quantity merged | core unit test (AC-A2) |
| Same request retried (same `requestId`) | List unchanged | core unit test (AC-A8); replay in a new process (AC-ST2) |
| Storage unavailable / write fails | Clear error, no success message | storage tests (AC-A14, AC-ST6, AC-ST7); corrupt store through MCP (AC-A15, AC-L4) |
| UI: add and display | Items appear with correct quantities | planned |
| UI: mark as bought | Item disappears from the open list | planned |

### Manual check (planned, not yet run)

Planned once dm's MCP server and the UI are connected: a documented example run in Claude Code with both servers: request → dm search → selection → item on the list → visible in the UI. Neither dm nor the UI is integrated yet, and this run has not been done. The open manual check of the three current tools is described under *Use it with Claude Code*.

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

