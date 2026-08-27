import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import {
  buildEmbeddingText,
  generateEmbedding,
  isEmbeddingValidationError,
} from "../shared/embedding";
import { logError, logInfo, requireEnv } from "../shared/http";
import { notFoundFailure, success, validationFailure } from "../shared/results";
import type { CoreResult } from "../shared/results";
import {
  isConditionalCheckFailed,
  recipeToItem,
  UUID_PATTERN,
  validateRecipeInput,
} from "../shared/types";

const dynamodb = new DynamoDBClient({});

export interface UpdateRecipeOutput {
  recipeId: string;
  message: string;
}

export const updateRecipe = async (
  recipeId: unknown,
  input: unknown,
): Promise<CoreResult<UpdateRecipeOutput>> => {
  if (typeof recipeId !== "string" || !UUID_PATTERN.test(recipeId)) {
    return validationFailure("recipeId must be a UUID");
  }

  const validation = validateRecipeInput(input);
  if (!validation.ok) {
    return validationFailure(`Invalid recipe: ${validation.errors.join("; ")}`);
  }

  const recipe = validation.recipe;
  let embedding: number[];
  try {
    embedding = await generateEmbedding(buildEmbeddingText(recipe));
  } catch (error) {
    if (isEmbeddingValidationError(error)) {
      logError("embedding rejected recipe text", error, { recipeId });
      return validationFailure("Recipe text could not be embedded");
    }
    throw error;
  }

  try {
    // Single conditional write; the condition is the existence check, so
    // there is deliberately no read-before-write.
    await dynamodb.send(
      new PutItemCommand({
        TableName: requireEnv("TABLE_NAME"),
        Item: recipeToItem(recipeId, recipe, embedding),
        ConditionExpression: "attribute_exists(recipeId)",
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      logInfo("recipe not found for update", { recipeId });
      return notFoundFailure("Recipe not found");
    }
    throw error;
  }

  logInfo("recipe updated", { recipeId });
  return success({ recipeId, message: "Recipe updated" });
};
