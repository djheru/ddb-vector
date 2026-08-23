import { DeleteItemCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  badRequest,
  internalError,
  jsonResponse,
  logError,
  logInfo,
  notFound,
  requireEnv,
} from "../shared/http";
import { isConditionalCheckFailed, UUID_PATTERN } from "../shared/types";

const dynamodb = new DynamoDBClient({});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const recipeId = event.pathParameters?.recipeId;
  try {
    if (!recipeId || !UUID_PATTERN.test(recipeId)) {
      return badRequest("recipeId must be a UUID");
    }

    await dynamodb.send(
      new DeleteItemCommand({
        TableName: requireEnv("TABLE_NAME"),
        Key: { recipeId: { S: recipeId } },
        ConditionExpression: "attribute_exists(recipeId)",
      }),
    );

    logInfo("recipe deleted", { recipeId });
    return jsonResponse(200, { message: "Recipe deleted" });
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      logInfo("recipe not found for delete", { recipeId });
      return notFound("Recipe not found");
    }
    logError("failed to delete recipe", error, { recipeId });
    return internalError();
  }
};
