import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { logInfo, requireEnv } from "../shared/http";
import { notFoundFailure, success, validationFailure } from "../shared/results";
import type { CoreResult } from "../shared/results";
import { UUID_PATTERN } from "../shared/types";

const dynamodb = new DynamoDBClient({});

export const getRecipe = async (
  recipeId: unknown,
): Promise<CoreResult<Record<string, unknown>>> => {
  if (typeof recipeId !== "string" || !UUID_PATTERN.test(recipeId)) {
    return validationFailure("recipeId must be a UUID");
  }

  const output = await dynamodb.send(
    new GetItemCommand({
      TableName: requireEnv("TABLE_NAME"),
      Key: { recipeId: { S: recipeId } },
    }),
  );

  if (!output.Item) {
    logInfo("recipe not found", { recipeId });
    return notFoundFailure("Recipe not found");
  }

  const recipe = unmarshall(output.Item);
  // GetItem returns the stored vector; it must never reach the client.
  delete recipe.embedding;

  logInfo("recipe fetched", { recipeId });
  return success(recipe);
};
