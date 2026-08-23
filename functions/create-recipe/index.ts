import { randomUUID } from "node:crypto";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  buildEmbeddingText,
  generateEmbedding,
  isEmbeddingValidationError,
} from "../shared/embedding";
import {
  badRequest,
  internalError,
  jsonResponse,
  logError,
  logInfo,
  parseJsonBody,
  requireEnv,
} from "../shared/http";
import { recipeToItem, validateRecipeInput } from "../shared/types";

const dynamodb = new DynamoDBClient({});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const parsed = parseJsonBody(event.body);
    if (parsed === undefined) return badRequest("Request body must be valid JSON");

    const validation = validateRecipeInput(parsed);
    if (!validation.ok) return badRequest(`Invalid recipe: ${validation.errors.join("; ")}`);

    const recipe = validation.recipe;
    const recipeId = randomUUID();
    const embedding = await generateEmbedding(buildEmbeddingText(recipe));

    // Conditional put: paranoia against UUID collision costs nothing.
    await dynamodb.send(
      new PutItemCommand({
        TableName: requireEnv("TABLE_NAME"),
        Item: recipeToItem(recipeId, recipe, embedding),
        ConditionExpression: "attribute_not_exists(recipeId)",
      }),
    );

    logInfo("recipe created", { recipeId });
    return jsonResponse(201, { recipeId, message: "Recipe created" });
  } catch (error) {
    if (isEmbeddingValidationError(error)) {
      logError("embedding rejected recipe text", error);
      return badRequest("Recipe text could not be embedded");
    }
    logError("failed to create recipe", error);
    return internalError();
  }
};
