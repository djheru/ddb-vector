import type { InvokeModelCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
import type { RecipeInput } from "../../functions/shared/types";

export const TEST_TABLE_NAME = "TestRecipes";
export const TEST_INDEX_NAME = "RecipeEmbeddingIndex";
export const TEST_LIST_INDEX_NAME = "RecipeListIndex";
export const TEST_MODEL_ID = "amazon.titan-embed-text-v2:0";

export const setHandlerEnv = (): void => {
  process.env.TABLE_NAME = TEST_TABLE_NAME;
  process.env.EMBEDDING_MODEL_ID = TEST_MODEL_ID;
  process.env.VECTOR_INDEX_NAME = TEST_INDEX_NAME;
  process.env.LIST_INDEX_NAME = TEST_LIST_INDEX_NAME;
  process.env.SIMILARITY_THRESHOLD = "0.3";
};

/** Minimal Bedrock InvokeModel response carrying an embedding payload. */
export const embeddingResponse = (
  embedding: number[],
): { body: InvokeModelCommandOutput["body"] } => ({
  body: new TextEncoder().encode(
    JSON.stringify({ embedding }),
  ) as unknown as InvokeModelCommandOutput["body"],
});

export const apiEvent = (input: {
  body?: unknown;
  rawBody?: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
}): APIGatewayProxyEvent =>
  ({
    body:
      input.rawBody !== undefined
        ? input.rawBody
        : input.body !== undefined
          ? JSON.stringify(input.body)
          : null,
    pathParameters: input.pathParameters ?? null,
    queryStringParameters: input.queryStringParameters ?? null,
  }) as unknown as APIGatewayProxyEvent;

export const validRecipe: RecipeInput = {
  name: "Spicy Chicken Stew",
  cuisine: "mexican",
  dietary: ["gluten-free"],
  prepTimeMinutes: 15,
  cookTimeMinutes: 45,
  servings: 4,
  description: "A fiery, slow-simmered chicken stew with chipotle and tomatoes.",
  ingredients: [
    { name: "chicken thighs", amount: "600", unit: "g" },
    { name: "chipotle peppers", amount: "2", unit: "pieces" },
  ],
  steps: ["Brown the chicken thoroughly", "Simmer with chipotle and tomatoes for 45 minutes"],
};

export const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";

export const storedItem = (
  recipeId: string,
  name: string,
  cuisine: string,
): Record<string, AttributeValue> => ({
  recipeId: { S: recipeId },
  name: { S: name },
  cuisine: { S: cuisine },
  dietary: { L: [{ S: "gluten-free" }] },
  prepTimeMinutes: { N: "15" },
  cookTimeMinutes: { N: "45" },
  servings: { N: "4" },
  description: { S: "A fiery, slow-simmered chicken stew with chipotle and tomatoes." },
  ingredients: {
    L: [{ M: { name: { S: "chicken thighs" }, amount: { S: "600" }, unit: { S: "g" } } }],
  },
  steps: { L: [{ S: "Brown the chicken thoroughly" }] },
});

export const parseBody = (body: string): Record<string, unknown> =>
  JSON.parse(body) as Record<string, unknown>;
