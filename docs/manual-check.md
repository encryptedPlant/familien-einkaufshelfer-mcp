# Manual check: Claude Code with the einkaufshelfer MCP server

Two manual runs, both on 2026-11-18 in the Claude desktop app on Windows, against the local demo store `data/demo-store.json` (git-ignored, seeded with the fictional favourites from `data/sample-favorites.json`). Only what was observed in those chats is recorded; the *Source* column keeps raw tool output apart from Claude's report of a tool result. Real dm product details (names, article numbers, GTINs, links) and store contents are deliberately not recorded. The automated tests (real server process driven by the MCP SDK client, see README) are separate from these checks.

- [Phase 1 run](#phase-1-run): `resolve_items`, `add_to_shopping_list`, `get_shopping_list` – all five checks passed.
- [Phase 2 run](#phase-2-run): dm's MCP server together with `get_favorites` and `save_favorite` – all checks passed.

## Phase 1 run

**Status: performed on 2026-11-18**, in two Claude Code chats (separate sessions). During chat 1 one real dm product was added to the demo store as a direct product (details deliberately not recorded, see below). All five checks passed; see *Deviations* for how the run differed from the plan.

Scope: phase 1 tools `resolve_items`, `add_to_shopping_list` and `get_shopping_list`. dm, favourite management and the UI are not part of this run.

### Setup

- Demo store created as described in the README (*Use it with Claude Code*).
- Observed at the start of chat 1: the project server `einkaufshelfer` was connected with `resolve_items`, `add_to_shopping_list` and `get_shopping_list`; `get_shopping_list` returned `{"entries":[]}`.

### Results

| # | Check | Request to Claude | Observed | Source | Result |
|---|---|---|---|---|---|
| 1 | Resolve and add | Chat 1: „füge 2 packungen feuchttücher der einkaufsliste hinzu“ | Resolved to the favourite Feuchttücher sensitiv without a follow-up question; new entry with quantity 2 | Claude's report | passed |
| | | Chat 2: „Wir brauchen zwei Packungen der üblichen Feuchttücher.“ | Same favourite; merged into the open entry, 4 → 6 | Claude's report; later `get_shopping_list` output (favoriteId, quantity 6) | passed |
| 2 | Technical retry | Chat 2: „Rufe add_to_shopping_list noch einmal mit genau denselben Argumenten und derselben requestId auf und zeig mir danach die Einkaufsliste.“ | `replayed: true`; quantity stayed 6 | Claude's report; list afterwards: 6 | passed |
| 3 | New request | Chat 1: „Wir brauchen zusätzlich noch einmal zwei Packungen derselben Feuchttücher. Das ist ein neuer Einkaufswunsch. …“ | New requestId (not the one of the first request), `replayed: false`, `action: merged`, quantity 2 → 4 | Claude's report incl. the requestId | passed |
| 4 | Ambiguous term | Chat 2: „Bitte etwas Zahnpflege auf die Liste“, follow-up question not answered, then „Zeig mir die Einkaufsliste.“ | `resolve_items` → `ambiguous` with Zahnpasta Minze and Zahnpasta Kräuter; Claude asked which one and how many; no `add_to_shopping_list` call; list without toothpaste | Raw output of `resolve_items` and `get_shopping_list` | passed |
| 5 | Persistence across sessions | Chat 2 (new session): first request, later „Zeig mir die Einkaufsliste.“ | Entries from chat 1 still present: the Feuchttücher entry (4 at the start of chat 2) and the directly added product from chat 1, with their entry ids and `addedAt` times from chat 1 | Claude's report; raw `get_shopping_list` output | passed |

### Further observations (chat 1)

- Unknown terms: several search terms for a product without a favourite, and „Testprodukt Fantasiewolke“, returned `unknown`. Claude added nothing for them, did not invent a favoriteId or article number, and asked for a concrete product.
- After a web search on dm.de and an explicit choice by the user, Claude added that product as a direct product with `dmUrl` only (it did not use the number in the link as an article number). The result was `replayed: false`, `action: created`. Product details are not recorded here because they are real dm data, not demo data. The web search was not the dm MCP integration; that was checked in the phase 2 run.

### Deviations from the plan

- The checks were spread across two chats and done in a different order. Chat 2 started with a non-empty list, so its first add merged (4 → 6) instead of creating an entry; creating an entry was observed in chat 1.
- Several results are Claude's summaries of tool results; raw output was shown for `resolve_items` (ambiguous, unknown), the direct-product add and `get_shopping_list`.
- The demo store kept the real product from chat 1; it was still there in the phase 2 run.

## Phase 2 run

**Status: performed on 2026-11-18**, in two Claude Code chats (separate sessions) with both project servers from `.mcp.json`: `einkaufshelfer` (demo store) and dm's public server `dm-drogeriemarkt`. One real dm product, chosen as an impersonal test product (a liquid hand soap), was saved as a favourite in the demo store and added to the list. All checks passed; see *Deviations*.

Scope: dm's MCP server (search and product details), `get_favorites`, `save_favorite`, and `resolve_items` / `add_to_shopping_list` / `get_shopping_list` with the new favourite. Not part of this run: a private store with real favourites and the UI.

### Setup

- Observed at the start of chat 1: `einkaufshelfer` offered five tools (`resolve_items`, `add_to_shopping_list`, `get_favorites`, `get_shopping_list`, `save_favorite`); `dm-drogeriemarkt` offered `searchProducts`, `getProductDetails`, `renderProductTiles`, `findNearbyStores` and `getStoreAvailability`.
- Store path: Claude reported the server's start-up line from the Claude Code log, `store: …\data\demo-store.json`, matching `EINKAUFSHELFER_DATA_FILE` in `.mcp.json`; `data/store.json` was not used.
- Starting state: `get_favorites` returned the 6 fictional favourites; `get_shopping_list` returned the 2 open entries left over from the phase 1 run.

### Results

Chat 1 is the live run; chat 2 is a new session that only called `get_favorites` and `get_shopping_list`.

| # | Check | Request to Claude | Observed | Source | Result |
|---|---|---|---|---|---|
| 1 | Search via dm only | Chat 1: search a simple hand soap as an impersonal test product via the dm MCP only, no web search; at most three hits with brand, variant, pack size, link and the identifier fields actually returned; save nothing | `searchProducts`, then `getProductDetails` for three hits; no web search; nothing saved | Tool calls and output in the session transcript; Claude's report | passed |
| 2 | Identifiers returned by dm | (same) | Per product dm returned `dan`, `gtin` and a link (`appLink` in the search, `productUrl` in the details). The link was a dm app link (`www.dm.de/applink/p/d/…`) with the tracking parameter `wt_mc=dm-mcp`, not a plain product page. Claude proposed storing only the DAN as `dmArticleNumber` and leaving out the GTIN and the app link | Raw dm tool output; Claude's report | passed |
| 3 | Save after explicit confirmation | Chat 1: user chose hit 1 and asked to save it with category „Handpflege“, alias „meine Demo-Handseife“, the dm-confirmed DAN only, without GTIN and app link | `save_favorite` with name, category, alias and `dmArticleNumber` only; result with a server-generated id and `createdAt`, no `dmUrl`; `get_favorites` afterwards: 7 favourites, the other 6 unchanged; list unchanged | Raw output of `save_favorite`; `get_favorites` | passed |
| 4 | Duplicate alias | Chat 1: save the same favourite again with alias „  MEINE DEMO-HANDSEIFE  “, no alternative spelling on error; later again with „MEINE DEMO-HANDSEIFE “ (trailing space) | Both times `DUPLICATE_ALIAS` with the id of the saved favourite in `details`; no retry with another spelling; `get_favorites` afterwards: still 7 favourites, alias unchanged | Raw output of `save_favorite`; `get_favorites` | passed |
| 5 | Resolve and add the new favourite | Chat 1: „Wir brauchen zwei Packungen meiner Demo-Handseife.“ with `resolve_items` and a new requestId | `resolve_items` → `resolved` to the saved favourite; `add_to_shopping_list` with a new requestId → `replayed: false`, `action: created`, quantity 2; `get_shopping_list`: new entry with the favourite's id and only the DAN as identifier, the 2 earlier entries unchanged | Tool output in the session transcript; Claude's report | passed |
| 6 | Persistence across sessions | Chat 2 (new session): only `get_favorites` and `get_shopping_list`, change nothing | The favourite is still there with the same id as in chat 1, the same alias and DAN; the list entry still refers to that id with quantity 2; no further favourite with that alias | Raw output of `get_favorites` and `get_shopping_list`, compared with the `save_favorite` output in chat 1; confirmed by the user | passed |

### Further observations (chat 1)

- The request to add two packs of „meiner Demo-Handseife“ arrived while no product had been chosen yet. `resolve_items` returned `unknown`; Claude did not call `add_to_shopping_list`, invented no favoriteId and asked for a choice. The add was done after the favourite had been saved (check 5).
- dm's tool output contains an instruction for the client to include dm.de links with tracking parameters (`utm_medium`, `utm_source`). That is guidance for the client's answer; this server stores no such link.

### Deviations from the plan

- The user's later requests (add, duplicate alias) arrived mid-turn before a product was chosen. Claude handled them in that order: nothing was saved or added before the explicit choice, and the duplicate-alias check was done only after the first save.
- Checks 1, 2 and 5 are taken from the tool calls and output in the session transcript together with Claude's report; Claude showed raw output in the chat for `save_favorite` (success and `DUPLICATE_ALIAS`) only.
- No dm product page URL (`dmUrl`) was confirmed in this run, so storing and merging by `dmUrl` from dm data was not checked live (it is covered by the automated tests).
- The demo store now contains two real dm products (from the phase 1 and phase 2 runs). It is local and git-ignored; reset it (delete it and seed again) before the next run.
