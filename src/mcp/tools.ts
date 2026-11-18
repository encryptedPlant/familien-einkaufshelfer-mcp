// MCP tool definitions and handlers (SPEC §6.1–6.3, §6.5, §6.6). Uses the
// core logic, the input validation and the Store interface; no business
// rules here.

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CoreError, Result } from "../core/errors";
import { resolveItems } from "../core/matching";
import { openEntries } from "../core/shopping-list";
import {
  addToShoppingListInputSchema,
  getFavoritesInputSchema,
  getShoppingListInputSchema,
  resolveItemsInputSchema,
  saveFavoriteInputSchema,
  validateAddToShoppingListInput,
  validateGetFavoritesInput,
  validateGetShoppingListInput,
  validateResolveItemsInput,
  validateSaveFavoriteInput,
} from "../core/validation";
import {
  addToShoppingListInStore,
  saveFavoriteInStore,
} from "../store/operations";
import type { Store } from "../store/store";

export type ToolDeps = {
  readonly store: Store;
  /** ISO 8601 UTC timestamp for new entries and favourites. */
  readonly now: () => string;
  /** New UUID for each created list entry or favourite. */
  readonly newId: () => string;
  /** Diagnostics (stderr). */
  readonly log: (message: string) => void;
};

/** JSON Schema of the accepted input, generated from the validation schema. */
const inputSchema = (schema: z.ZodType): Tool["inputSchema"] =>
  z.toJSONSchema(schema, { io: "input" }) as Tool["inputSchema"];

export const TOOLS: readonly Tool[] = [
  {
    name: "resolve_items",
    title: "Resolve items to favourites",
    description: [
      "Resolves requested shopping items to the family's saved favourites. Read-only.",
      "Matching is exact after normalisation (case, extra whitespace): alias first, then name, then category; no substring or fuzzy matching.",
      "Returns one result per item, in input order: `resolved` (exactly one favourite), `ambiguous` (several candidates) or `unknown`.",
      "Client guidance (not enforced by the server): for `ambiguous` or `unknown`, ask the user; do not pick a candidate yourself and never invent a favoriteId.",
      "Only `resolved` results may be added via their favoriteId without a further product choice.",
    ].join(" "),
    inputSchema: inputSchema(resolveItemsInputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "add_to_shopping_list",
    title: "Add to shopping list",
    description: [
      "Adds items to the shopping list. The same product (same dm article number, dm URL or favourite) is merged into its open entry and the quantity increased.",
      "Each item is either { favoriteId, quantity } for a favourite that resolve_items returned as `resolved`, or { product, quantity } for a concrete product the user has explicitly selected (needs dmArticleNumber or dmUrl).",
      "requestId rules: use a new unique requestId (e.g. a UUID) for every new intended request.",
      "Reuse a requestId only to technically retry the same request with the same items in the same order; the retry returns the stored result with replayed: true and changes nothing.",
      "A later identical shopping wish is a new request and needs a new requestId.",
      "If the outcome is unclear after a possible write (e.g. timeout or lost connection), retry the same request with the same requestId instead of creating a new one.",
      "Never work around REQUEST_ID_CONFLICT by retrying automatically with a new requestId; report it to the user.",
      "Any error rejects the whole request and nothing is written; errors come as isError with a JSON body { code, message, details }.",
    ].join(" "),
    inputSchema: inputSchema(addToShoppingListInputSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true, // for identical arguments incl. the same requestId
      openWorldHint: false,
    },
  },
  {
    name: "get_shopping_list",
    title: "Get shopping list",
    description:
      "Returns the open shopping list entries, oldest first (by addedAt); bought entries are not included. Read-only; takes no arguments.",
    inputSchema: inputSchema(getShoppingListInputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_favorites",
    title: "Get favourites",
    description:
      "Returns all saved favourites with id, name, category, aliases and the stored dm identifiers (dmArticleNumber, dmUrl), in the order they were saved. Read-only; takes no arguments.",
    inputSchema: inputSchema(getFavoritesInputSchema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "save_favorite",
    title: "Save favourite",
    description: [
      "Saves a new favourite and returns it with a server-generated id.",
      "Only call it after the user has explicitly asked to save a product and has confirmed the concrete product (brand, variant, pack size).",
      "Store only identifiers that are confirmed for that product: dmArticleNumber is the dm article number (DAN), not a GTIN/EAN and not a number taken from a product URL unless it is confirmed to be the DAN; dmUrl is the dm product page (not the start page). Leave out what is not confirmed; never invent identifiers.",
      "Aliases must be unique across all favourites after normalisation (case, whitespace); a collision, also within the given aliases, fails with DUPLICATE_ALIAS and nothing is saved. Names may repeat.",
      "Not idempotent: every successful call creates another favourite, even with identical data. If the outcome of a call is unclear (e.g. timeout or lost connection), call get_favorites first to check whether it was saved; do not repeat the call blindly.",
      "Errors come as isError with a JSON body { code, message, details }.",
    ].join(" "),
    inputSchema: inputSchema(saveFavoriteInputSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

/**
 * SPEC §4.7: INTERNAL_ERROR for unexpected exceptions. It never claims
 * success, but does not guarantee that nothing was changed.
 */
type ToolErrorBody = Omit<CoreError, "code"> & {
  readonly code: CoreError["code"] | "INTERNAL_ERROR";
};

export async function callTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
): Promise<CallToolResult> {
  // Own properties only: names such as "constructor" or "toString" must not
  // reach Object.prototype methods.
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (handler === undefined) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  }
  try {
    return toCallToolResult(await handler(args, deps));
  } catch (error) {
    // Never report success and never write to stdout; details go to stderr.
    deps.log(
      `unexpected error in ${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return errorResult({
      code: "INTERNAL_ERROR",
      message: internalErrorMessage(name),
    });
  }
}

/**
 * Tool-specific guidance for INTERNAL_ERROR (SPEC §4.7): never claims
 * success; only add_to_shopping_list has a safe retry (same requestId,
 * same items); a save_favorite retry could create a duplicate favourite.
 */
function internalErrorMessage(name: string): string {
  const base = "Unexpected server error; details are in the server log.";
  switch (name) {
    case "add_to_shopping_list":
      return `${base} Success is not confirmed. Check get_shopping_list; if you retry, use the same requestId and the same items.`;
    case "save_favorite":
      return `${base} It is unclear whether the favourite was saved. Check get_favorites first; do not call save_favorite again blindly.`;
    default:
      return `${base} No result is available.`;
  }
}

type Handler = (args: unknown, deps: ToolDeps) => Promise<Result<object>>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  async resolve_items(args, { store }) {
    const input = validateResolveItemsInput(args);
    if (!input.ok) return input;
    const state = await store.read();
    if (!state.ok) return state;
    return {
      ok: true,
      value: resolveItems(input.value, state.value.favorites),
    };
  },

  async add_to_shopping_list(args, { store, now, newId }) {
    const input = validateAddToShoppingListInput(args);
    if (!input.ok) return input;
    // requestId check, merge and write happen in one locked store update.
    return addToShoppingListInStore(store, input.value, { now: now(), newId });
  },

  async get_shopping_list(args, { store }) {
    const input = validateGetShoppingListInput(args);
    if (!input.ok) return input;
    const state = await store.read();
    if (!state.ok) return state;
    return { ok: true, value: { entries: openEntries(state.value.list) } };
  },

  async get_favorites(args, { store }) {
    const input = validateGetFavoritesInput(args);
    if (!input.ok) return input;
    const state = await store.read();
    if (!state.ok) return state;
    return { ok: true, value: { favorites: state.value.favorites } };
  },

  async save_favorite(args, { store, now, newId }) {
    const input = validateSaveFavoriteInput(args);
    if (!input.ok) return input;
    // Alias check and write happen in one locked store update.
    const saved = await saveFavoriteInStore(store, input.value, {
      now: now(),
      newId,
    });
    if (!saved.ok) return saved;
    return { ok: true, value: { favorite: saved.value } };
  },
};

function toCallToolResult(result: Result<object>): CallToolResult {
  if (!result.ok) return errorResult(result.error);
  return {
    content: [{ type: "text", text: JSON.stringify(result.value) }],
    structuredContent: result.value as Record<string, unknown>,
  };
}

function errorResult(error: ToolErrorBody): CallToolResult {
  const body = {
    code: error.code,
    message: error.message,
    ...(error.details !== undefined ? { details: error.details } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}
