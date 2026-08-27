import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  badRequest,
  failureResponse,
  internalError,
  jsonResponse,
  logError,
  parseJsonBody,
} from "../shared/http";
import { updateRecipe } from "./core";

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const recipeId = event.pathParameters?.recipeId;
  try {
    const parsed = parseJsonBody(event.body);
    if (parsed === undefined) return badRequest("Request body must be valid JSON");

    const result = await updateRecipe(recipeId, parsed);
    if (!result.ok) return failureResponse(result);
    return jsonResponse(200, result.value);
  } catch (error) {
    logError("failed to update recipe", error, { recipeId });
    return internalError();
  }
};
