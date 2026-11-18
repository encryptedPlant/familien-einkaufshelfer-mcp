// Error codes and result type shared by the core functions (SPEC §4.7).

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "FAVORITE_NOT_FOUND"
  | "PRODUCT_IDENTITY_CONFLICT"
  | "QUANTITY_LIMIT"
  | "REQUEST_ID_CONFLICT"
  | "DUPLICATE_ALIAS"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_CORRUPT";

export type CoreError = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CoreError };
