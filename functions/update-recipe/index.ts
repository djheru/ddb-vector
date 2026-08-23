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
  notFound,
  parseJsonBody,
  requireEnv,
} from "../shared/http";
import {
  isConditionalCheckFailed,
  recipeToItem,
  UUID_PATTERN,
  validateRecipeInput,
} from "../shared/types";

const dynamodb = new DynamoDBClient({});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const recipeId = event.pathParameters?.recipeId;
  try {
    if (!recipeId || !UUID_PATTERN.test(recipeId)) {
      return badRequest("recipeId must be a UUID");
    }

    const parsed = parseJsonBody(event.body);
    if (parsed === undefined) return badRequest("Request body must be valid JSON");

    const validation = validateRecipeInput(parsed);
    if (!validation.ok) return badRequest(`Invalid recipe: ${validation.errors.join("; ")}`);

    const recipe = validation.recipe;
    const embedding = await generateEmbedding(buildEmbeddingText(recipe));

    // Single conditional write; the condition is the existence check, so
    // there is deliberately no read-before-write.
    await dynamodb.send(
      new PutItemCommand({
        TableName: requireEnv("TABLE_NAME"),
        Item: recipeToItem(recipeId, recipe, embedding),
        ConditionExpression: "attribute_exists(recipeId)",
      }),
    );

    logInfo("recipe updated", { recipeId });
    return jsonResponse(200, { recipeId, message: "Recipe updated" });
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      logInfo("recipe not found for update", { recipeId });
      return notFound("Recipe not found");
    }
    if (isEmbeddingValidationError(error)) {
      logError("embedding rejected recipe text", error, { recipeId });
      return badRequest("Recipe text could not be embedded");
    }
    logError("failed to update recipe", error, { recipeId });
    return internalError();
  }
};
