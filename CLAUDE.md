# CLAUDE.md

MCP server (TypeScript) that turns structured shopping requests from an AI client into a clean family shopping list, plus a small Next.js UI later. `SPEC.md` is the source of truth for behaviour and acceptance criteria; review changes against it. `README.md` must reflect the state actually reached (SPEC R10).

## Layout

- `src/core/` pure domain logic, no I/O: validation, normalisation, identity, matching, saving favourites, merging and idempotency (`addToShoppingList` takes the state, time and ID generator from the caller) · `src/store/` storage: `resolveStorePath()`, `Store` (`read`, `update(fn)`), JSON file adapter with cross-process lock, `addToShoppingListInStore`, seed · `src/mcp/` MCP stdio server: `tools.ts` (definitions, handlers), `server.ts` (SDK `Server` wiring), `main.ts` (start-up)
- `bin/einkaufshelfer-mcp.mjs` server entry point (node + local tsx loader) · `.mcp.json` project MCP config: `einkaufshelfer` with the demo store `data/demo-store.json` and dm's public server `dm-drogeriemarkt` (Claude combines both; our server never calls dm; private stores belong in the local MCP scope, never in `.mcp.json`) · `scripts/seed.ts` behind `npm run seed`
- `app/` Next.js App Router UI (currently only a placeholder start page)
- `docs/manual-check.md` manual Claude Code check; record only observed results
- `tests/` Vitest tests, `*.test.ts` only (`tests/fixtures/` holds fixed, fictional sample data; `tests/store/worker.ts` runs as a separate process via the tsx loader; `tests/mcp/` drives the real server process through the SDK client) · `e2e/` Playwright specs, `*.spec.ts` only
- `data/` local store (git-ignored); only fictional `data/sample-*.json` is committed
- `.claude/settings.json` Stop hook → `.claude/hooks/check.mjs`

## Commands

- `npm run dev` Next.js dev server on http://localhost:3000
- `npm run typecheck` `tsc --noEmit`
- `npm test` Vitest once (`vitest run --passWithNoTests`); never starts browsers
- `npm run test:e2e` Playwright (starts `npm run dev` itself)
- `npm run format` / `npm run format:check` Prettier (Markdown is excluded)
- `npm run seed` fictional sample favourites into a missing or empty store (honours `EINKAUFSHELFER_DATA_FILE`)
- `npm run mcp` MCP server on stdio (`node bin/einkaufshelfer-mcp.mjs`)

## Conventions

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; validate every tool input with Zod.
- Code, comments and docs in English; UI texts and sample data in German.
- Automated tests use fixed sample data only: never call dm's MCP server or an LLM.
- Storage: always go through `Store.update(fn)` (one locked read-change-write); never write the store file directly. Tests use their own temp directories and must never touch `data/store.json`; synchronise processes with messages, not sleeps.
- MCP server: stdout is reserved for MCP messages; log only to stderr. Tool input is validated by `src/core/validation.ts` (not by the SDK) so that every error, including invalid input, is a tool result `{ code, message, details }` with `isError: true`. Tool handlers only combine validation, core logic and `Store`; no business rules in `src/mcp/`.
- Run `npm run format` before handing work over.
- Next.js 16 differs from older versions: read the guide in `node_modules/next/dist/docs/` before writing UI code.
- Stop hook: runs typecheck and Vitest when you finish a turn and blocks on failure (exit 2). Fix the cause; never weaken, skip or delete tests to get green. After 3 blocked stops in one turn a loop guard lets the turn end and says so explicitly. The hook mirrors the `typecheck` and `test` scripts; keep both in sync.
- Never commit real household data, secrets, `.env*` files, the local store (`data/store.json`) or test artefacts (`test-results/`, `playwright-report/`).
- Commits: small and focused; show the summary and planned message and wait for approval before committing, pushing or merging.
- Before every commit, check the effective author address with `git config user.email`. It must be the confirmed GitHub noreply address of the account encryptedPlant, `69851071+encryptedPlant@users.noreply.github.com`. If it differs, stop. Never change the global Git configuration.
