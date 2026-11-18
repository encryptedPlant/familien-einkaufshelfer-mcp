// Validation of the persisted StoreFile (SPEC §3, §4.6). Pure, no I/O.
//
// Stored data must already be in canonical form: text trimmed, dm URLs
// normalised. Field limits and patterns are shared with the input
// validation; nothing is normalised here, only checked.

import { z } from "zod";
import type { Result } from "./errors";
import { normalize, normalizeDmUrl } from "./normalize";
import type { StoreFile } from "./types";
import {
  DM_ARTICLE_NUMBER_PATTERN,
  DM_URL_MAX,
  MAX_ALIASES,
  quantity,
  REQUEST_ID_PATTERN,
  TEXT_MAX,
} from "./validation";

/** The state of a missing store file: version 1 with empty arrays. */
export function emptyStore(): StoreFile {
  return { version: 1, favorites: [], list: [], processedRequests: [] };
}

const storedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s === s.trim(), "must be stored trimmed");

const id = z.uuid();
const timestamp = z.iso.datetime(); // UTC ("Z") only
const dmArticleNumber = z.string().regex(DM_ARTICLE_NUMBER_PATTERN);
const dmUrl = z
  .string()
  .max(DM_URL_MAX)
  .refine(
    (url) => normalizeDmUrl(url) === url,
    "must be a normalised dm product URL",
  );

const productRef = z.strictObject({
  name: storedText(TEXT_MAX.name),
  category: storedText(TEXT_MAX.category).optional(),
  dmArticleNumber: dmArticleNumber.optional(),
  dmUrl: dmUrl.optional(),
});

const favorite = z.strictObject({
  id,
  name: storedText(TEXT_MAX.name),
  category: storedText(TEXT_MAX.category),
  aliases: z
    .array(
      storedText(TEXT_MAX.alias).refine(
        (alias) => normalize(alias) !== "",
        "must not be empty after normalisation",
      ),
    )
    .max(MAX_ALIASES),
  dmArticleNumber: dmArticleNumber.optional(),
  dmUrl: dmUrl.optional(),
  createdAt: timestamp,
});

const listEntry = z
  .strictObject({
    id,
    product: productRef,
    favoriteId: id.optional(),
    quantity,
    status: z.enum(["open", "bought"]),
    addedAt: timestamp,
    boughtAt: timestamp.optional(),
  })
  .refine((e) => (e.status === "bought") === (e.boughtAt !== undefined), {
    message: "boughtAt must be set exactly when status is bought",
  });

const addResult = z.strictObject({
  requestId: z.string().regex(REQUEST_ID_PATTERN),
  replayed: z.literal(false),
  entries: z
    .array(
      z.strictObject({
        entryId: id,
        name: storedText(TEXT_MAX.name),
        quantity,
        action: z.enum(["created", "merged"]),
      }),
    )
    .min(1)
    .max(50),
});

const processedRequest = z
  .strictObject({
    requestId: z.string().regex(REQUEST_ID_PATTERN),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    result: addResult,
    processedAt: timestamp,
  })
  .refine((p) => p.result.requestId === p.requestId, {
    message: "result.requestId must equal requestId",
  });

const storeFileSchema = z
  .strictObject({
    version: z.literal(1),
    favorites: z.array(favorite),
    list: z.array(listEntry),
    processedRequests: z.array(processedRequest),
  })
  .superRefine((store, ctx) => {
    const duplicate = (
      values: readonly string[],
      path: (string | number)[],
      what: string,
    ) => {
      const seen = new Set<string>();
      for (const value of values) {
        if (seen.has(value)) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `duplicate ${what} "${value}"`,
          });
        }
        seen.add(value);
      }
    };
    duplicate(
      store.favorites.map((f) => f.id),
      ["favorites"],
      "favourite id",
    );
    duplicate(
      store.favorites.flatMap((f) => f.aliases.map(normalize)),
      ["favorites"],
      "alias (after normalisation)",
    );
    duplicate(
      store.list.map((e) => e.id),
      ["list"],
      "list entry id",
    );
    duplicate(
      store.processedRequests.map((p) => p.requestId),
      ["processedRequests"],
      "requestId",
    );
  });

/** Validates parsed store content; any violation is `STORAGE_CORRUPT`. */
export function validateStoreFile(data: unknown): Result<StoreFile> {
  if (
    data !== null &&
    typeof data === "object" &&
    "version" in data &&
    data.version !== 1
  ) {
    return corrupt(`unsupported store version ${JSON.stringify(data.version)}`);
  }
  const parsed = storeFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    }));
    const summary = issues
      .slice(0, 5)
      .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
      .join("; ");
    return corrupt(`invalid store content: ${summary}`, { issues });
  }
  // The schema mirrors StoreFile; parsed JSON never contains `undefined`
  // values, so absent optional fields are simply missing as required by
  // exactOptionalPropertyTypes.
  return { ok: true, value: parsed.data as StoreFile };
}

function corrupt(
  message: string,
  details?: Record<string, unknown>,
): Result<never> {
  return {
    ok: false,
    error: {
      code: "STORAGE_CORRUPT",
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
}
