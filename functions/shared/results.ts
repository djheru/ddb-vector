/**
 * Transport-agnostic outcome of a core operation. Expected failures come back
 * as values so the REST and AppSync wrappers can each map them to their own
 * surface (400/404 bodies vs GraphQL errors); unexpected errors keep throwing
 * and are sanitized by the wrapper's catch-all.
 */
export type CoreFailureKind = "validation" | "not_found";

export interface CoreFailure {
  readonly ok: false;
  readonly kind: CoreFailureKind;
  readonly message: string;
}

export interface CoreSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type CoreResult<T> = CoreSuccess<T> | CoreFailure;

export const success = <T>(value: T): CoreResult<T> => ({ ok: true, value });

export const validationFailure = (message: string): CoreFailure => ({
  ok: false,
  kind: "validation",
  message,
});

export const notFoundFailure = (message: string): CoreFailure => ({
  ok: false,
  kind: "not_found",
  message,
});
