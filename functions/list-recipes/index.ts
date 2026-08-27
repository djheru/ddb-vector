import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { failureResponse, internalError, jsonResponse, logError } from "../shared/http";
import { listRecipes } from "./core";

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const result = await listRecipes({
      pageSize: event.queryStringParameters?.pageSize,
      cursor: event.queryStringParameters?.cursor,
    });
    if (!result.ok) return failureResponse(result);
    return jsonResponse(200, result.value);
  } catch (error) {
    logError("failed to list recipes", error);
    return internalError();
  }
};
