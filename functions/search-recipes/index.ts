import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  badRequest,
  failureResponse,
  internalError,
  jsonResponse,
  logError,
  parseJsonBody,
} from "../shared/http";
import { isRecord } from "../shared/types";
import { searchRecipes } from "./core";

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const parsed = parseJsonBody(event.body);
    if (!isRecord(parsed)) return badRequest("Request body must be a JSON object");

    const result = await searchRecipes(parsed);
    if (!result.ok) return failureResponse(result);
    return jsonResponse(200, result.value);
  } catch (error) {
    logError("failed to search recipes", error);
    return internalError();
  }
};
