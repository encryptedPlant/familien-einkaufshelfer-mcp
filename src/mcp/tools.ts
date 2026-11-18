// MCP tool definitions and handlers (SPEC §6.1–6.3). Uses the core logic,
// the input validation and the Store interface; no business rules here.

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CoreError, Result } from "../core/errors";
import { resolveItems } from "../core/matching";
import { openEntries } from "../core/shopping-list";
import {
  addToShoppingListInputSchema,
  getShoppingListInputSchema,
  resolveItemsInputSchema,
  validateAddToShoppingListInput,
  validateGetShoppingListInput,
  validateResolveItemsInput,
} from "../core/validation";
import { addToShoppingListInStore } from "../store/operations";
import type { Store } from "../store/store";

export type ToolDeps = {
  readonly store: Store;
  /** ISO 8601 UTC timestamp for new entries. */
  readonly now: () => string;
  /** New UUID for each created list entry. */
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
  const handler = HANDLERS[name];
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
      message:
        "Unexpected server error; success is not confirmed. Check the current state before retrying (the same requestId is safe to retry). Details are in the server log.",
    });
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
