import { util } from "@aws-appsync/utils";

/**
 * Shared APPSYNC_JS resolver for every field, attached once per resolver in
 * the stack. The lambdalith returns an envelope ({ data } or
 * { error: { message, type } }); this response handler raises util.error so
 * the GraphQL errors array carries a typed errorType instead of the
 * "Lambda:Unhandled" a direct resolver would report for a thrown error.
 */
export function request(ctx) {
  return { operation: "Invoke", payload: ctx };
}

export function response(ctx) {
  // Lambda crashes (timeout, out-of-memory) never produce an envelope;
  // sanitize them here so infrastructure detail cannot leak to clients.
  if (ctx.error) {
    util.error("Internal server error", "InternalError");
  }
  if (ctx.result && ctx.result.error) {
    util.error(ctx.result.error.message, ctx.result.error.type);
  }
  return ctx.result.data;
}
