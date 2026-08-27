import { DynamoDBClient, SearchVectorsCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { generateEmbedding, isEmbeddingValidationError } from "../shared/embedding";
import { logError, logInfo, requireEnv } from "../shared/http";
import {
  decodeCursor,
  encodeCursor,
  isSearchCursor,
  searchFingerprint,
} from "../shared/pagination";
import { success, validationFailure } from "../shared/results";
import type { CoreResult } from "../shared/results";
import {
  CUISINE_MAX_LENGTH,
  CUISINE_MIN_LENGTH,
  CUISINE_PATTERN,
  CURSOR_MAX_LENGTH,
  QUERY_MAX_LENGTH,
  QUERY_MIN_LENGTH,
  SEARCH_CANDIDATE_POOL_SIZE,
  TOP_K_DEFAULT,
  TOP_K_MAX,
  TOP_K_MIN,
} from "../shared/types";

const dynamodb = new DynamoDBClient({});

const DEFAULT_SIMILARITY_THRESHOLD = 0.15;
const SIMILARITY_DECIMAL_PLACES = 4;
const ROUNDING_FACTOR = 10 ** SIMILARITY_DECIMAL_PLACES;

const round = (value: number): number => Math.round(value * ROUNDING_FACTOR) / ROUNDING_FACTOR;

export interface SearchResultShape {
  recipeId: string;
  name: string;
  cuisine?: string;
  description?: string;
  dietary?: string[];
  prepTimeMinutes?: number;
  cookTimeMinutes?: number;
  servings?: number;
  similarity: number;
  distance: number;
}

export interface SearchRecipesOutput {
  query: string;
  cuisine?: string;
  results: SearchResultShape[];
  nextCursor?: string;
}

export const searchRecipes = async (
  request: Record<string, unknown>,
): Promise<CoreResult<SearchRecipesOutput>> => {
  const { query, cuisine, topK, cursor } = request;
  if (
    typeof query !== "string" ||
    query.length < QUERY_MIN_LENGTH ||
    query.length > QUERY_MAX_LENGTH
  ) {
    return validationFailure(
      `query must be a string of ${QUERY_MIN_LENGTH}-${QUERY_MAX_LENGTH} characters`,
    );
  }
  if (
    cuisine !== undefined &&
    (typeof cuisine !== "string" ||
      cuisine.length < CUISINE_MIN_LENGTH ||
      cuisine.length > CUISINE_MAX_LENGTH ||
      !CUISINE_PATTERN.test(cuisine))
  ) {
    return validationFailure("cuisine must match the recipe cuisine format");
  }
  if (topK !== undefined && (typeof topK !== "number" || !Number.isInteger(topK))) {
    return validationFailure("topK must be an integer");
  }
  const clampedTopK = Math.min(TOP_K_MAX, Math.max(TOP_K_MIN, topK ?? TOP_K_DEFAULT));

  // The engine has no native pagination: every request fetches the full
  // candidate pool (engine cap) and slices it at a cursor offset. The cursor
  // carries a fingerprint binding it to this exact query and filter.
  const fingerprint = searchFingerprint(query, cuisine);
  let offset = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || cursor.length > CURSOR_MAX_LENGTH) {
      return validationFailure("cursor is not valid");
    }
    const decoded = decodeCursor(cursor);
    if (!isSearchCursor(decoded)) return validationFailure("cursor is not valid");
    if (decoded.fingerprint !== fingerprint) {
      return validationFailure("cursor does not match this query");
    }
    offset = decoded.offset;
  }

  // Same model and dimensions as write time; this invariant is what makes
  // the search meaningful.
  let queryVector: number[];
  try {
    queryVector = await generateEmbedding(query);
  } catch (error) {
    if (isEmbeddingValidationError(error)) {
      logError("embedding rejected search query", error);
      return validationFailure("Query could not be embedded");
    }
    throw error;
  }

  const response = await dynamodb.send(
    new SearchVectorsCommand({
      TableName: requireEnv("TABLE_NAME"),
      IndexName: requireEnv("VECTOR_INDEX_NAME"),
      SearchVector: queryVector.map((component) => ({ N: String(component) })),
      TopK: SEARCH_CANDIDATE_POOL_SIZE,
      ...(cuisine !== undefined && {
        SearchConditionExpression: "cuisine = :cuisine",
        ExpressionAttributeValues: { ":cuisine": { S: cuisine } },
      }),
    }),
  );

  const threshold = Number(process.env.SIMILARITY_THRESHOLD ?? DEFAULT_SIMILARITY_THRESHOLD);
  const pool = (response.SearchResults ?? [])
    .flatMap((result): SearchResultShape[] => {
      if (!result.Item || typeof result.Score !== "number") return [];
      const item = unmarshall(result.Item);
      // COSINE Score is a distance: lower is better, 0 means identical.
      const distance = result.Score;
      const similarity = round(1 - distance);
      return [
        {
          recipeId: item.recipeId as string,
          name: item.name as string,
          cuisine: item.cuisine as string | undefined,
          description: item.description as string | undefined,
          dietary: item.dietary as string[] | undefined,
          prepTimeMinutes: item.prepTimeMinutes as number | undefined,
          cookTimeMinutes: item.cookTimeMinutes as number | undefined,
          servings: item.servings as number | undefined,
          similarity,
          distance,
        },
      ];
    })
    .filter((result) => result.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);

  const results = pool.slice(offset, offset + clampedTopK);
  const nextOffset = offset + clampedTopK;
  const hasMore = pool.length > nextOffset;

  logInfo("search complete", {
    query,
    cuisine,
    topK: clampedTopK,
    offset,
    poolSize: pool.length,
    resultCount: results.length,
  });
  return success({
    query,
    ...(cuisine !== undefined && { cuisine }),
    results,
    ...(hasMore && { nextCursor: encodeCursor({ offset: nextOffset, fingerprint }) }),
  });
};
