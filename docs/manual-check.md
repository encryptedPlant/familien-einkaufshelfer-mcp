# Manual check: Claude Code with the einkaufshelfer MCP server

**Status: performed on 2026-11-18**, in two Claude Code chats (separate sessions) in the Claude desktop app on Windows, against the local demo store `data/demo-store.json`. It was seeded with the fictional favourites from `data/sample-favorites.json`; during chat 1 one real dm product was added to it as a direct product (details deliberately not recorded, see below). Only what was observed in those chats is recorded, and the *Source* column keeps raw tool output apart from Claude's report of a tool result. All five checks passed; see *Deviations* for how the run differed from the plan.

Scope: phase 1 tools `resolve_items`, `add_to_shopping_list` and `get_shopping_list`. dm, favourite management and the UI are not part of this check. The automated tests (real server process driven by the MCP SDK client, see README) are separate from this check.

## Setup

- Demo store created as described in the README (*Use it with Claude Code*).
- Observed at the start of chat 1: the project server `einkaufshelfer` was connected with `resolve_items`, `add_to_shopping_list` and `get_shopping_list`; `get_shopping_list` returned `{"entries":[]}`.

## Results

| # | Check | Request to Claude | Observed | Source | Result |
|---|---|---|---|---|---|
| 1 | Resolve and add | Chat 1: „füge 2 packungen feuchttücher der einkaufsliste hinzu“ | Resolved to the favourite Feuchttücher sensitiv without a follow-up question; new entry with quantity 2 | Claude's report | passed |
| | | Chat 2: „Wir brauchen zwei Packungen der üblichen Feuchttücher.“ | Same favourite; merged into the open entry, 4 → 6 | Claude's report; later `get_shopping_list` output (favoriteId, quantity 6) | passed |
| 2 | Technical retry | Chat 2: „Rufe add_to_shopping_list noch einmal mit genau denselben Argumenten und derselben requestId auf und zeig mir danach die Einkaufsliste.“ | `replayed: true`; quantity stayed 6 | Claude's report; list afterwards: 6 | passed |
| 3 | New request | Chat 1: „Wir brauchen zusätzlich noch einmal zwei Packungen derselben Feuchttücher. Das ist ein neuer Einkaufswunsch. …“ | New requestId (not the one of the first request), `replayed: false`, `action: merged`, quantity 2 → 4 | Claude's report incl. the requestId | passed |
| 4 | Ambiguous term | Chat 2: „Bitte etwas Zahnpflege auf die Liste“, follow-up question not answered, then „Zeig mir die Einkaufsliste.“ | `resolve_items` → `ambiguous` with Zahnpasta Minze and Zahnpasta Kräuter; Claude asked which one and how many; no `add_to_shopping_list` call; list without toothpaste | Raw output of `resolve_items` and `get_shopping_list` | passed |
| 5 | Persistence across sessions | Chat 2 (new session): first request, later „Zeig mir die Einkaufsliste.“ | Entries from chat 1 still present: the Feuchttücher entry (4 at the start of chat 2) and the directly added product from chat 1, with their entry ids and `addedAt` times from chat 1 | Claude's report; raw `get_shopping_list` output | passed |

## Further observations (chat 1)

- Unknown terms: several search terms for a product without a favourite, and „Testprodukt Fantasiewolke“, returned `unknown`. Claude added nothing for them, did not invent a favoriteId or article number, and asked for a concrete product.
- After a web search on dm.de and an explicit choice by the user, Claude added that product as a direct product with `dmUrl` only (it did not use the number in the link as an article number). The result was `replayed: false`, `action: created`. Product details are not recorded here because they are real dm data, not demo data. The web search is not the planned dm MCP integration.

## Deviations from the plan

- The checks were spread across two chats and done in a different order. Chat 2 started with a non-empty list, so its first add merged (4 → 6) instead of creating an entry; creating an entry was observed in chat 1.
- Several results are Claude's summaries of tool results; raw output was shown for `resolve_items` (ambiguous, unknown), the direct-product add and `get_shopping_list`.
- The demo store now also contains the real product from chat 1. It is local and git-ignored; reset the demo store (delete it and seed again) before the next run.
