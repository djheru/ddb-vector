import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

/**
 * Embedding dimensionality shared by the Bedrock request, the stored vectors,
 * and the vector index definition in the stack. Write-time and query-time
 * embeddings must agree on this for search to be meaningful.
 */
export const EMBEDDING_DIMENSIONS = 1024;

// Field bounds mirror openapi/openapi.yaml, the single source of truth for the
// contract. The gateway validates first; handlers re-validate as defense in depth.
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 200;
export const CUISINE_MIN_LENGTH = 2;
export const CUISINE_MAX_LENGTH = 100;
export const CUISINE_PATTERN = /^[a-zA-Z][a-zA-Z\s-]+$/;
export const DIETARY_TAG_MIN_LENGTH = 2;
export const DIETARY_TAG_MAX_LENGTH = 50;
export const DIETARY_MAX_ITEMS = 20;
export const DESCRIPTION_MIN_LENGTH = 10;
export const DESCRIPTION_MAX_LENGTH = 2000;
export const TIME_MINUTES_MIN = 0;
export const TIME_MINUTES_MAX = 10080;
export const SERVINGS_MIN = 1;
export const SERVINGS_MAX = 1000;
export const INGREDIENT_NAME_MIN_LENGTH = 2;
export const INGREDIENT_NAME_MAX_LENGTH = 100;
export const INGREDIENT_AMOUNT_MIN_LENGTH = 1;
export const INGREDIENT_AMOUNT_MAX_LENGTH = 20;
export const INGREDIENT_UNIT_MIN_LENGTH = 1;
export const INGREDIENT_UNIT_MAX_LENGTH = 30;
export const INGREDIENTS_MIN_ITEMS = 1;
export const INGREDIENTS_MAX_ITEMS = 100;
export const STEP_MIN_LENGTH = 5;
export const STEP_MAX_LENGTH = 1000;
export const STEPS_MIN_ITEMS = 1;
export const STEPS_MAX_ITEMS = 50;
export const QUERY_MIN_LENGTH = 1;
export const QUERY_MAX_LENGTH = 1000;
export const TOP_K_MIN = 1;
export const TOP_K_MAX = 25;
export const TOP_K_DEFAULT = 5;

// Stored-item defaults for the optional numeric fields, matching the reference
// implementation's item shape.
export const DEFAULT_PREP_TIME_MINUTES = 0;
export const DEFAULT_COOK_TIME_MINUTES = 0;
export const DEFAULT_SERVINGS = 1;

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Ingredient {
  name: string;
  amount: string;
  unit: string;
}

export interface RecipeInput {
  name: string;
  cuisine: string;
  dietary?: string[];
  prepTimeMinutes?: number;
  cookTimeMinutes?: number;
  servings?: number;
  description: string;
  ingredients: Ingredient[];
  steps: string[];
}

export interface ValidationSuccess {
  ok: true;
  recipe: RecipeInput;
}

export interface ValidationFailure {
  ok: false;
  errors: string[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const checkString = (
  path: string,
  value: unknown,
  minLength: number,
  maxLength: number,
  pattern?: RegExp,
): string[] => {
  if (typeof value !== "string") return [`${path}: must be a string`];
  if (value.length < minLength || value.length > maxLength) {
    return [`${path}: length must be ${minLength}-${maxLength}`];
  }
  if (pattern && !pattern.test(value)) return [`${path}: invalid format`];
  return [];
};

const checkOptionalInteger = (
  path: string,
  value: unknown,
  min: number,
  max: number,
): string[] => {
  if (value === undefined || value === null) return [];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return [`${path}: must be an integer in range ${min}-${max}`];
  }
  return [];
};

export const validateRecipeInput = (value: unknown): ValidationResult => {
  if (!isRecord(value)) {
    return { ok: false, errors: ["body: must be a JSON object"] };
  }

  const errors: string[] = [];
  errors.push(...checkString("name", value.name, NAME_MIN_LENGTH, NAME_MAX_LENGTH));
  errors.push(
    ...checkString("cuisine", value.cuisine, CUISINE_MIN_LENGTH, CUISINE_MAX_LENGTH, CUISINE_PATTERN),
  );
  errors.push(
    ...checkString("description", value.description, DESCRIPTION_MIN_LENGTH, DESCRIPTION_MAX_LENGTH),
  );
  errors.push(
    ...checkOptionalInteger("prepTimeMinutes", value.prepTimeMinutes, TIME_MINUTES_MIN, TIME_MINUTES_MAX),
  );
  errors.push(
    ...checkOptionalInteger("cookTimeMinutes", value.cookTimeMinutes, TIME_MINUTES_MIN, TIME_MINUTES_MAX),
  );
  errors.push(...checkOptionalInteger("servings", value.servings, SERVINGS_MIN, SERVINGS_MAX));

  if (value.dietary !== undefined) {
    if (!Array.isArray(value.dietary) || value.dietary.length > DIETARY_MAX_ITEMS) {
      errors.push(`dietary: must be an array of at most ${DIETARY_MAX_ITEMS} tags`);
    } else {
      value.dietary.forEach((tag, index) => {
        errors.push(
          ...checkString(
            `dietary[${index}]`,
            tag,
            DIETARY_TAG_MIN_LENGTH,
            DIETARY_TAG_MAX_LENGTH,
            CUISINE_PATTERN,
          ),
        );
      });
    }
  }

  if (
    !Array.isArray(value.ingredients) ||
    value.ingredients.length < INGREDIENTS_MIN_ITEMS ||
    value.ingredients.length > INGREDIENTS_MAX_ITEMS
  ) {
    errors.push(
      `ingredients: must be an array of ${INGREDIENTS_MIN_ITEMS}-${INGREDIENTS_MAX_ITEMS} items`,
    );
  } else {
    value.ingredients.forEach((ingredient, index) => {
      if (!isRecord(ingredient)) {
        errors.push(`ingredients[${index}]: must be an object`);
        return;
      }
      errors.push(
        ...checkString(
          `ingredients[${index}].name`,
          ingredient.name,
          INGREDIENT_NAME_MIN_LENGTH,
          INGREDIENT_NAME_MAX_LENGTH,
        ),
      );
      errors.push(
        ...checkString(
          `ingredients[${index}].amount`,
          ingredient.amount,
          INGREDIENT_AMOUNT_MIN_LENGTH,
          INGREDIENT_AMOUNT_MAX_LENGTH,
        ),
      );
      errors.push(
        ...checkString(
          `ingredients[${index}].unit`,
          ingredient.unit,
          INGREDIENT_UNIT_MIN_LENGTH,
          INGREDIENT_UNIT_MAX_LENGTH,
        ),
      );
    });
  }

  if (
    !Array.isArray(value.steps) ||
    value.steps.length < STEPS_MIN_ITEMS ||
    value.steps.length > STEPS_MAX_ITEMS
  ) {
    errors.push(`steps: must be an array of ${STEPS_MIN_ITEMS}-${STEPS_MAX_ITEMS} items`);
  } else {
    value.steps.forEach((step, index) => {
      errors.push(...checkString(`steps[${index}]`, step, STEP_MIN_LENGTH, STEP_MAX_LENGTH));
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  // Reconstruct with only the contract's fields so unknown properties never
  // reach the table, even if the gateway validation were bypassed.
  const record = value as Record<string, unknown>;
  const recipe: RecipeInput = {
    name: record.name as string,
    cuisine: record.cuisine as string,
    description: record.description as string,
    ingredients: (record.ingredients as Record<string, unknown>[]).map((ingredient) => ({
      name: ingredient.name as string,
      amount: ingredient.amount as string,
      unit: ingredient.unit as string,
    })),
    steps: record.steps as string[],
  };
  if (record.dietary !== undefined) recipe.dietary = record.dietary as string[];
  if (record.prepTimeMinutes !== undefined) recipe.prepTimeMinutes = record.prepTimeMinutes as number;
  if (record.cookTimeMinutes !== undefined) recipe.cookTimeMinutes = record.cookTimeMinutes as number;
  if (record.servings !== undefined) recipe.servings = record.servings as number;
  return { ok: true, recipe };
};

/**
 * Marshals a recipe into the reference implementation's item shape: strings,
 * numbers, dietary as a string list, ingredients as a list of maps, steps as a
 * string list, and the embedding stored with the existing List type.
 */
export const recipeToItem = (
  recipeId: string,
  recipe: RecipeInput,
  embedding: number[],
): Record<string, AttributeValue> => ({
  recipeId: { S: recipeId },
  name: { S: recipe.name },
  cuisine: { S: recipe.cuisine },
  dietary: { L: (recipe.dietary ?? []).map((tag) => ({ S: tag })) },
  prepTimeMinutes: { N: String(recipe.prepTimeMinutes ?? DEFAULT_PREP_TIME_MINUTES) },
  cookTimeMinutes: { N: String(recipe.cookTimeMinutes ?? DEFAULT_COOK_TIME_MINUTES) },
  servings: { N: String(recipe.servings ?? DEFAULT_SERVINGS) },
  description: { S: recipe.description },
  ingredients: {
    L: recipe.ingredients.map((ingredient) => ({
      M: {
        name: { S: ingredient.name },
        amount: { S: ingredient.amount },
        unit: { S: ingredient.unit },
      },
    })),
  },
  steps: { L: recipe.steps.map((step) => ({ S: step })) },
  embedding: { L: embedding.map((component) => ({ N: String(component) })) },
});

export const isConditionalCheckFailed = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException ||
  (error instanceof Error && error.name === "ConditionalCheckFailedException");
