import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { requireEnv } from "./http";
import { EMBEDDING_DIMENSIONS, isRecord } from "./types";
import type { RecipeInput } from "./types";

const bedrock = new BedrockRuntimeClient({});

/** Raised when Bedrock rejects the input itself; callers map this to a 400. */
export class EmbeddingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingValidationError";
  }
}

export const isEmbeddingValidationError = (error: unknown): error is EmbeddingValidationError =>
  error instanceof EmbeddingValidationError ||
  (error instanceof Error && error.name === "EmbeddingValidationError");

/**
 * Builds the text that gets embedded. Deliberately excludes the prep/cook time
 * sentence the reference implementation had: numeric times add noise to the
 * vector. Times remain stored attributes on the item.
 */
export const buildEmbeddingText = (recipe: RecipeInput): string => {
  const ingredientNames = recipe.ingredients.map((ingredient) => ingredient.name).join(", ");
  const dietaryInfo = recipe.dietary?.length ? `Dietary: ${recipe.dietary.join(", ")}.` : "";

  return [
    recipe.name,
    recipe.description,
    `Cuisine: ${recipe.cuisine}.`,
    dietaryInfo,
    `Ingredients: ${ingredientNames}.`,
  ]
    .filter(Boolean)
    .join(" ");
};

export const generateEmbedding = async (text: string): Promise<number[]> => {
  const modelId = requireEnv("EMBEDDING_MODEL_ID");
  try {
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          inputText: text,
          dimensions: EMBEDDING_DIMENSIONS,
          normalize: true,
        }),
      }),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body));
    const embedding = isRecord(parsed) ? parsed.embedding : undefined;
    if (
      !Array.isArray(embedding) ||
      !embedding.every((component): component is number => typeof component === "number")
    ) {
      throw new Error("Bedrock response did not contain a numeric embedding array");
    }
    return embedding;
  } catch (error) {
    if (error instanceof Error && error.name === "ValidationException") {
      throw new EmbeddingValidationError(`Embedding model rejected the input: ${error.message}`);
    }
    throw error;
  }
};
