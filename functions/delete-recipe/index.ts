import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { failureResponse, internalError, jsonResponse, logError } from "../shared/http";
import { deleteRecipe } from "./core";

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const recipeId = event.pathParameters?.recipeId;
  try {
    const result = await deleteRecipe(recipeId);
    if (!result.ok) return failureResponse(result);
    return jsonResponse(200, result.value);
  } catch (error) {
    logError("failed to delete recipe", error, { recipeId });
    return internalError();
  }
};
