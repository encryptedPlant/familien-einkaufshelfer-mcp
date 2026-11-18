// Input validation for the phase 1 tools (SPEC §4.1, §6.1, §6.2). Pure, no I/O.
//
// Validation also normalises: text fields are trimmed and dm URLs are
// normalised, so equivalent spellings of the same input validate to equal
// values (needed for idempotency, SPEC §4.5).

import { z } from "zod";
import type { Result } from "./errors";
import { normalizeDmUrl } from "./normalize";
import type {
  AddItem,
  AddToShoppingListInput,
  ProductRef,
  ResolveItemsInput,
} from "./types";

/** Shared limits and patterns; also used to validate the stored data. */
export const TEXT_MAX = {
  name: 200,
  category: 100,
  alias: 100,
  term: 200,
} as const;
export const MAX_ALIASES = 20;
export const DM_ARTICLE_NUMBER_PATTERN = /^\d{1,13}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const quantity = z.int().min(1).max(99);

/** Trimmed text; the length limit applies to the trimmed value (SPEC §4.1). */
const text = (max: number) => z.string().trim().min(1).max(max);

const dmArticleNumber = z
  .string()
  .trim()
  .regex(DM_ARTICLE_NUMBER_PATTERN, "must consist of 1–13 digits");

const dmUrl = z.string().transform((raw, ctx) => {
  const url = normalizeDmUrl(raw);
  if (url === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "must be a dm product URL on www.dm.de or dm.de",
    });
    return z.NEVER;
  }
  return url;
});

const productRefSchema = z
  .strictObject({
    name: text(TEXT_MAX.name),
    category: text(TEXT_MAX.category).optional(),
    dmArticleNumber: dmArticleNumber.optional(),
    dmUrl: dmUrl.optional(),
  })
  .refine((p) => p.dmArticleNumber !== undefined || p.dmUrl !== undefined, {
    message: "a direct product needs a dmArticleNumber or a dmUrl",
  });

const resolveItemsSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        term: text(TEXT_MAX.term),
        quantity: quantity.default(1),
      }),
    )
    .min(1)
    .max(50),
});

// One object with exactly one of `favoriteId` / `product` instead of a union,
// so that field errors keep their path (e.g. `items.0.product.dmUrl`).
const addItemSchema = z
  .strictObject({
    favoriteId: z.string().min(1).optional(),
    product: productRefSchema.optional(),
    quantity,
  })
  .refine(
    (item) => (item.favoriteId === undefined) !== (item.product === undefined),
    {
      message: "an item needs exactly one of favoriteId or product",
    },
  );

const addToShoppingListSchema = z.strictObject({
  requestId: z
    .string()
    .regex(REQUEST_ID_PATTERN, "must be 1–128 characters of [A-Za-z0-9_-]"),
  items: z.array(addItemSchema).min(1).max(50),
});

export function validateResolveItemsInput(
  input: unknown,
): Result<ResolveItemsInput> {
  const parsed = resolveItemsSchema.safeParse(input);
  if (!parsed.success) return validationError("resolve_items", parsed.error);
  return { ok: true, value: { items: parsed.data.items } };
}

export function validateAddToShoppingListInput(
  input: unknown,
): Result<AddToShoppingListInput> {
  const parsed = addToShoppingListSchema.safeParse(input);
  if (!parsed.success)
    return validationError("add_to_shopping_list", parsed.error);
  const items: AddItem[] = [];
  for (const { favoriteId, product, quantity } of parsed.data.items) {
    if (favoriteId !== undefined) items.push({ favoriteId, quantity });
    else if (product !== undefined)
      items.push({ product: toProductRef(product), quantity });
  }
  return { ok: true, value: { requestId: parsed.data.requestId, items } };
}

/** Builds a ProductRef without keys for absent optional fields. */
function toProductRef(p: z.infer<typeof productRefSchema>): ProductRef {
  return {
    name: p.name,
    ...(p.category !== undefined ? { category: p.category } : {}),
    ...(p.dmArticleNumber !== undefined
      ? { dmArticleNumber: p.dmArticleNumber }
      : {}),
    ...(p.dmUrl !== undefined ? { dmUrl: p.dmUrl } : {}),
  };
}

function validationError(tool: string, error: z.ZodError): Result<never> {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const summary = issues
    .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
    .join("; ");
  return {
    ok: false,
    error: {
      code: "VALIDATION_ERROR",
      message: `Invalid ${tool} input: ${summary}`,
      details: { issues },
    },
  };
}
