import { randomUUID } from "node:crypto";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import {
  buildEmbeddingText,
  generateEmbedding,
  isEmbeddingValidationError,
} from "../shared/embedding";
import { logError, logInfo, requireEnv } from "../shared/http";
import { success, validationFailure } from "../shared/results";
import type { CoreResult } from "../shared/results";
import { recipeToItem, validateRecipeInput } from "../shared/types";

const dynamodb = new DynamoDBClient({});

export interface CreateRecipeOutput {
  recipeId: string;
  message: string;
}

export const createRecipe = async (input: unknown): Promise<CoreResult<CreateRecipeOutput>> => {
  const validation = validateRecipeInput(input);
  if (!validation.ok) {
    return validationFailure(`Invalid recipe: ${validation.errors.join("; ")}`);
  }

  const recipe = validation.recipe;
  const recipeId = randomUUID();

  let embedding: number[];
  try {
    embedding = await generateEmbedding(buildEmbeddingText(recipe));
  } catch (error) {
    if (isEmbeddingValidationError(error)) {
      logError("embedding rejected recipe text", error);
      return validationFailure("Recipe text could not be embedded");
    }
    throw error;
  }

  // Conditional put: paranoia against UUID collision costs nothing.
  await dynamodb.send(
    new PutItemCommand({
      TableName: requireEnv("TABLE_NAME"),
      Item: recipeToItem(recipeId, recipe, embedding),
      ConditionExpression: "attribute_not_exists(recipeId)",
    }),
  );

  logInfo("recipe created", { recipeId });
  return success({ recipeId, message: "Recipe created" });
};
