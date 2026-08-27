import type { CoreResult } from "./results";

/**
 * The lambdalith's response envelope. Direct Lambda resolvers surface thrown
 * errors as errorType "Lambda:Unhandled", so typed GraphQL errors are returned
 * as values instead: the shared APPSYNC_JS response handler raises
 * util.error(message, type) from this envelope, which is the AWS-documented
 * way to control errorType from a Lambda data source.
 */
export type ResolverErrorType = "ValidationError" | "NotFoundError" | "InternalError";

export interface ResolverError {
  error: { message: string; type: ResolverErrorType };
}

export interface ResolverData<T> {
  data: T;
}

export type ResolverEnvelope<T> = ResolverData<T> | ResolverError;

export const toEnvelope = <T>(result: CoreResult<T>): ResolverEnvelope<T> => {
  if (result.ok) return { data: result.value };
  return {
    error: {
      message: result.message,
      type: result.kind === "not_found" ? "NotFoundError" : "ValidationError",
    },
  };
};

/**
 * The GraphQL counterpart of the REST 500 rule: unexpected failures surface
 * with exactly this message; details go to the logs only.
 */
export const internalErrorEnvelope = (): ResolverError => ({
  error: { message: "Internal server error", type: "InternalError" },
});
