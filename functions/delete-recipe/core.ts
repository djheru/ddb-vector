import { DeleteItemCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { logInfo, requireEnv } from "../shared/http";
import { notFoundFailure, success, validationFailure } from "../shared/results";
import type { CoreResult } from "../shared/results";
import { isConditionalCheckFailed, UUID_PATTERN } from "../shared/types";

const dynamodb = new DynamoDBClient({});

export interface DeleteRecipeOutput {
  message: string;
}

export const deleteRecipe = async (recipeId: unknown): Promise<CoreResult<DeleteRecipeOutput>> => {
  if (typeof recipeId !== "string" || !UUID_PATTERN.test(recipeId)) {
    return validationFailure("recipeId must be a UUID");
  }

  try {
    await dynamodb.send(
      new DeleteItemCommand({
        TableName: requireEnv("TABLE_NAME"),
        Key: { recipeId: { S: recipeId } },
        ConditionExpression: "attribute_exists(recipeId)",
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      logInfo("recipe not found for delete", { recipeId });
      return notFoundFailure("Recipe not found");
    }
    throw error;
  }

  logInfo("recipe deleted", { recipeId });
  return success({ message: "Recipe deleted" });
};
