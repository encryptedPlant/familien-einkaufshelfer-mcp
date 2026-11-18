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
- The demo store now contains two real dm products (from the phase 1 and phase 2 runs). It is local and git-ignored. Reset it (delete it and seed again) only after a backup copy and the user's explicit approval.

### Supplementary run: dm link as `dmUrl` (chat 3)

Performed on 2026-11-18 in a third Claude Code session (started from another session), against the same demo store, to cover the gap above: saving a link returned by dm as `dmUrl`.

Sources: unless stated otherwise, each point below is taken from the tool output in the session transcript (raw output, visible to Claude). The user did not see that raw output. The user saw Claude's summaries in the chat and chose the product, the identifiers to store, the alias and the category in a question dialog.

- **Connection:** `einkaufshelfer` offered the same five tools and `dm-drogeriemarkt` the same five tools as in chat 1 (checked through the tools actually available in the session).
- **Store path (indirect evidence only):** the server's stderr line with the store path was not visible in this session. The demo store's modification time matched the time of the `add_to_shopping_list` call below, and its content matched the tool output. This makes it likely that the server used the demo store, but it does not show the resolved path itself.
- **Identifiers returned by dm** (`searchProducts`, 15 hits, and `getProductDetails` for 2 of them): `dan` (7 digits in all 17 results), `gtin` (13 digits in all 17), and a link (`appLink` / `productUrl`) of the form `www.dm.de/applink/p/d/<number>/<text>` with the query parameters `appPageType`, `appProductId` and `wt_mc`. In all 17 results, the number in the link path and `appProductId` equalled `dan`. That was observed only; dm does not document it.
- **Save:** after the user had chosen a product and asked to save it with DAN and dm link, alias and category, `save_favorite` returned the favourite with `dmArticleNumber` = the DAN and `dmUrl` normalised as specified. The query string was removed and the path, including `/applink/`, was kept. The GTIN was not stored.
- **Resolve:** the alias with different case and extra whitespace → `resolved` to the new favourite; the category term → `ambiguous` with three candidates (two fictional ones and the new favourite).
- **Add and list:** `add_to_shopping_list` with a new requestId → `replayed: false`, `action: created`, quantity 1. `get_shopping_list` showed the new entry with the favourite's id, the DAN and the normalised link; the earlier entries were unchanged.
- **Overlapping sessions:** while the product choice was pending in chat 3, chat 1 saved and added its favourite in the same demo store, about 50 minutes before chat 3 wrote (by the stored timestamps). The two sessions overlapped in time, but their writes did not happen at the same moment, so this is no evidence about simultaneous writes. Afterwards both changes were present in the tool output and in the file. Simultaneous writes from separate processes are covered by the automated process tests (AC-ST1, AC-ST3 and the test with two processes saving the same alias).

Data model conflicts (derived from SPEC §4.2 and the observed dm output, not tested live; no code change made):

1. A 13-digit GTIN matches the `dmArticleNumber` pattern (1–13 digits), so a GTIN passed as an article number by mistake would not be rejected. dm's own tools define the DAN as exactly 7 digits.
2. dm's MCP server returns app links (`/applink/p/d/<DAN>/<text>`), while the dm website link stored in the phase 1 run had the form `/p/d/<DAN>/<text>`. Normalisation keeps the path, so the two forms, and links with a different `<text>`, count as different URLs. Products identified only by such a URL would not be merged. If both sides have a DAN, rule 1 decides and the link form does not matter.

The demo store now contains three real dm products from these runs. Reset it only after a backup copy and the user's explicit approval.

## Private store setup

Performed on 2026-11-18. The private store lives outside the repository, so `git check-ignore` does not apply to it; `git status` showed no store file. Paths and contents are not recorded here.

**Status:**

- Confirmed: the registration in the local MCP scope, and a direct start of the server with the registered command.
- Still open: use of the private store in a new Claude Code session, i.e. that a new session's `einkaufshelfer` actually reads and writes it.
- Still open: the three personal favourites have not been saved yet.

Sources: the points below are taken from the command and tool output in the session transcripts of two sessions: the session that set up the store, and chat 3 for the later `claude mcp get` check. The user saw Claude's summaries.

- **Registration:** `claude mcp add-json --scope local einkaufshelfer '<json>'` with the complete start entry (`node`, the absolute path to `bin/einkaufshelfer-mcp.mjs`, `EINKAUFSHELFER_DATA_FILE`). `.mcp.json` was not changed. The `claude` CLI was not on the PATH; the Claude Code binary bundled with the desktop app was used, nothing was installed. In Git Bash the first attempt failed with `Invalid configuration: : Invalid input`, because the shell rewrote the Windows paths in the argument (MSYS path conversion). With `MSYS_NO_PATHCONV=1` and forward slashes it succeeded.
- **Checks:** `claude mcp get einkaufshelfer` showed `Scope: Local config (private to you in this project)` with that command, argument and variable. Compared with a backup of `~/.claude.json`, only this project's `mcpServers` and the app's own cache fields had changed. A direct start of the server with the same command and variable wrote the configured path as `store: …` to stderr and did not create the file. A later `claude mcp get einkaufshelfer` (chat 3) again showed the local scope and `Status: ✔ Connected`; the store file still did not exist.
- **Running sessions keep the old entry:** in a session that was already open, the server still used the demo store (`get_favorites` returned the demo favourites) after the MCP servers reconnected. The local entry only applies in a new Claude Code session.
- **Back to the demo:** `claude mcp remove einkaufshelfer -s local`. The project entry from `.mcp.json` with `data/demo-store.json` then applies again in new sessions. The private store file is not deleted.
