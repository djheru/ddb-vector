import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  badRequest,
  failureResponse,
  internalError,
  jsonResponse,
  logError,
  parseJsonBody,
} from "../shared/http";
import { createRecipe } from "./core";

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const parsed = parseJsonBody(event.body);
    if (parsed === undefined) return badRequest("Request body must be valid JSON");

    const result = await createRecipe(parsed);
    if (!result.ok) return failureResponse(result);
    return jsonResponse(201, result.value);
  } catch (error) {
    logError("failed to create recipe", error);
    return internalError();
  }
};
