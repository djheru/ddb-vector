import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
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
import { UUID_PATTERN } from "../shared/types";

const dynamodb = new DynamoDBClient({});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const recipeId = event.pathParameters?.recipeId;
  try {
    if (!recipeId || !UUID_PATTERN.test(recipeId)) {
      return badRequest("recipeId must be a UUID");
    }

    const output = await dynamodb.send(
      new GetItemCommand({
        TableName: requireEnv("TABLE_NAME"),
        Key: { recipeId: { S: recipeId } },
      }),
    );

    if (!output.Item) {
      logInfo("recipe not found", { recipeId });
      return notFound("Recipe not found");
    }

    const recipe = unmarshall(output.Item);
    // GetItem returns the stored vector; it must never reach the client.
    delete recipe.embedding;

    logInfo("recipe fetched", { recipeId });
    return jsonResponse(200, recipe);
  } catch (error) {
    logError("failed to get recipe", error, { recipeId });
    return internalError();
  }
};
