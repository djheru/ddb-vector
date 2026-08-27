import type { APIGatewayProxyResult } from "aws-lambda";
import type { CoreFailure } from "./results";

export const jsonResponse = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const badRequest = (error: string): APIGatewayProxyResult => jsonResponse(400, { error });

export const notFound = (error: string): APIGatewayProxyResult => jsonResponse(404, { error });

/** Maps a core failure to its REST status code. */
export const failureResponse = (failure: CoreFailure): APIGatewayProxyResult =>
  failure.kind === "validation" ? badRequest(failure.message) : notFound(failure.message);

/**
 * Every 500 body is exactly this generic message. Details are logged
 * server-side via logError and never leave the process.
 */
export const internalError = (): APIGatewayProxyResult =>
  jsonResponse(500, { error: "Internal server error" });

export const logInfo = (msg: string, context: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ level: "info", msg, ...context }));
};

const serializeError = (error: unknown): Record<string, unknown> =>
  error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { value: String(error) };

export const logError = (
  msg: string,
  error: unknown,
  context: Record<string, unknown> = {},
): void => {
  console.error(JSON.stringify({ level: "error", msg, error: serializeError(error), ...context }));
};

/** Returns undefined for a missing, empty, or malformed body instead of throwing. */
export const parseJsonBody = (body: string | null): unknown => {
  if (body === null || body === "") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
