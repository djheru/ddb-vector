/**
 * End-to-end sanity checks against a deployed environment. Runs in the
 * pipeline's ValidateDev step; the VectorIndex custom resource has already
 * blocked the deployment until the index was ACTIVE, so there are no waits,
 * sleeps, or readiness retries here by design.
 *
 * Usage: API_URL=https://... API_KEY=... GRAPHQL_URL=https://... \
 *        GRAPHQL_API_KEY=... npx tsx scripts/smoke.ts
 */
import { randomUUID } from "node:crypto";
import type { RecipeInput } from "../functions/shared/types";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
};

const apiUrl = requireEnv("API_URL").replace(/\/$/, "");
const apiKey = requireEnv("API_KEY");
const graphqlUrl = requireEnv("GRAPHQL_URL");
const graphqlApiKey = requireEnv("GRAPHQL_API_KEY");

// Matches the search function's default SIMILARITY_THRESHOLD.
const SIMILARITY_THRESHOLD = 0.15;

let failures = 0;
const check = (condition: boolean, label: string): void => {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}`);
  }
};

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

const request = async (method: string, path: string, payload?: unknown): Promise<ApiResult> => {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
};

// Distinctive on purpose; the search step paraphrases it with no shared keywords.
const smokeRecipe: RecipeInput = {
  name: "Smoky Chipotle Chicken Stew",
  cuisine: "mexican",
  dietary: ["gluten-free"],
  prepTimeMinutes: 15,
  cookTimeMinutes: 45,
  servings: 4,
  description:
    "A fiery, slow-simmered chicken stew with chipotle peppers, charred tomatoes, and warming spices.",
  ingredients: [
    { name: "chicken thighs", amount: "600", unit: "g" },
    { name: "chipotle peppers", amount: "2", unit: "pieces" },
  ],
  steps: ["Brown the chicken in batches", "Simmer with chipotle and tomatoes for 45 minutes"],
};

interface SearchResult {
  recipeId: string;
  cuisine?: string;
  similarity: number;
}

interface GraphqlError {
  errorType?: string;
  message?: string;
}

interface GraphqlResult {
  status: number;
  data: Record<string, unknown>;
  errors: GraphqlError[];
}

const graphql = async (
  query: string,
  variables: Record<string, unknown> = {},
  keyOverride?: string,
): Promise<GraphqlResult> => {
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": keyOverride ?? graphqlApiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return {
    status: response.status,
    data: (parsed.data ?? {}) as Record<string, unknown>,
    errors: (parsed.errors ?? []) as GraphqlError[],
  };
};

const CREATE_RECIPE_MUTATION = `mutation CreateRecipe($input: RecipeInput!) {
  createRecipe(input: $input) { recipeId message }
}`;

const GET_RECIPE_QUERY = `query GetRecipe($recipeId: ID!) {
  getRecipe(recipeId: $recipeId) { recipeId name cuisine description }
}`;

const SEARCH_RECIPES_QUERY = `query SearchRecipes($query: String!, $cuisine: String, $topK: Int) {
  searchRecipes(query: $query, cuisine: $cuisine, topK: $topK) {
    results { recipeId cuisine similarity distance }
  }
}`;

const LIST_RECIPES_QUERY = `query ListRecipes($pageSize: Int) {
  listRecipes(pageSize: $pageSize) { items { recipeId name } nextCursor }
}`;

const UPDATE_RECIPE_MUTATION = `mutation UpdateRecipe($recipeId: ID!, $input: RecipeInput!) {
  updateRecipe(recipeId: $recipeId, input: $input) { recipeId message }
}`;

const DELETE_RECIPE_MUTATION = `mutation DeleteRecipe($recipeId: ID!) {
  deleteRecipe(recipeId: $recipeId) { message }
}`;

/**
 * The GraphQL leg mirrors the REST flow through the AppSync lambdalith, then
 * pins the parts REST cannot express: the typed errorType contract that
 * graphql/resolver.js preserves, and AppSync's 401 for a bad api key.
 */
const graphqlChecks = async (): Promise<void> => {
  let recipeId: string | undefined;
  let deleted = false;

  try {
    // 1. Create through the mutation.
    const created = await graphql(CREATE_RECIPE_MUTATION, { input: smokeRecipe });
    check(created.status === 200, `graphql create returns 200 (got ${created.status})`);
    check(created.errors.length === 0, "graphql create returns no errors");
    const createAck = created.data.createRecipe as { recipeId?: string } | null | undefined;
    recipeId = createAck?.recipeId;
    check(typeof recipeId === "string", "graphql create returns a recipeId");
    if (!recipeId) throw new Error("cannot continue without a graphql recipeId");

    // 2. Get it back; the embedding is unreachable by schema, so only the
    //    stored fields are asserted.
    const fetched = await graphql(GET_RECIPE_QUERY, { recipeId });
    const fetchedRecipe = fetched.data.getRecipe as { name?: string } | null | undefined;
    check(fetchedRecipe?.name === smokeRecipe.name, "graphql get returns the stored name");

    // 3. Paraphrase search finds it through the same vector index.
    const search = await graphql(SEARCH_RECIPES_QUERY, { query: "hot and hearty poultry dish" });
    check(search.errors.length === 0, "graphql search returns no errors");
    const searchOutput = search.data.searchRecipes as { results?: SearchResult[] } | null;
    const results = searchOutput?.results ?? [];
    const match = results.find((result) => result.recipeId === recipeId);
    check(match !== undefined, "graphql semantic search finds the created recipe");
    check(
      (match?.similarity ?? 0) > SIMILARITY_THRESHOLD,
      `graphql similarity ${match?.similarity ?? "n/a"} is above the ${SIMILARITY_THRESHOLD} threshold`,
    );

    // 4. Cuisine filter narrows to one cuisine.
    const filtered = await graphql(SEARCH_RECIPES_QUERY, {
      query: "something spicy",
      cuisine: "mexican",
      topK: 5,
    });
    const filteredOutput = filtered.data.searchRecipes as { results?: SearchResult[] } | null;
    check(
      (filteredOutput?.results ?? []).every((result) => result.cuisine === "mexican"),
      "graphql cuisine filter returns only mexican recipes",
    );

    // 5. List returns a page.
    const listed = await graphql(LIST_RECIPES_QUERY, { pageSize: 5 });
    const listOutput = listed.data.listRecipes as { items?: unknown[] } | null;
    check(Array.isArray(listOutput?.items), "graphql list returns an items array");

    // 6. Update succeeds through the conditional write.
    const updated = await graphql(UPDATE_RECIPE_MUTATION, {
      recipeId,
      input: { ...smokeRecipe, description: `${smokeRecipe.description} Updated via GraphQL.` },
    });
    const updateAck = updated.data.updateRecipe as { message?: string } | null | undefined;
    check(updateAck?.message === "Recipe updated", "graphql update acknowledges");

    // 7. Typed error contract: a missing recipe surfaces as NotFoundError in
    //    the errors array (HTTP status stays 200 in GraphQL).
    const ghost = await graphql(GET_RECIPE_QUERY, { recipeId: randomUUID() });
    check(
      ghost.errors[0]?.errorType === "NotFoundError",
      `graphql missing recipe yields errorType NotFoundError (got ${ghost.errors[0]?.errorType ?? "none"})`,
    );

    // 8. Typed error contract: handler-level validation yields ValidationError.
    const invalid = await graphql(CREATE_RECIPE_MUTATION, {
      input: { ...smokeRecipe, description: "Short" },
    });
    check(
      invalid.errors[0]?.errorType === "ValidationError",
      `graphql invalid input yields errorType ValidationError (got ${invalid.errors[0]?.errorType ?? "none"})`,
    );

    // 9. A bad api key is rejected by AppSync with 401 (vs API Gateway's 403).
    const badKey = await graphql(LIST_RECIPES_QUERY, {}, "not-a-real-key");
    check(badKey.status === 401, `graphql request with a bad key returns 401 (got ${badKey.status})`);

    // 10. Delete it.
    const removed = await graphql(DELETE_RECIPE_MUTATION, { recipeId });
    const deleteAck = removed.data.deleteRecipe as { message?: string } | null | undefined;
    check(deleteAck?.message === "Recipe deleted", "graphql delete acknowledges");
    deleted = deleteAck?.message === "Recipe deleted";
  } finally {
    if (recipeId && !deleted) {
      await graphql(DELETE_RECIPE_MUTATION, { recipeId }).catch(() => undefined);
    }
  }
};

const main = async (): Promise<void> => {
  let recipeId: string | undefined;
  let deleted = false;

  try {
    // 1. Create a distinctive recipe.
    const created = await request("POST", "/recipes", smokeRecipe);
    check(created.status === 201, `create returns 201 (got ${created.status})`);
    recipeId = created.body.recipeId as string | undefined;
    check(typeof recipeId === "string", "create returns a recipeId");
    if (!recipeId) throw new Error("cannot continue without a recipeId");

    // 2. Get it and assert the embedding is absent.
    const fetched = await request("GET", `/recipes/${recipeId}`);
    check(fetched.status === 200, `get returns 200 (got ${fetched.status})`);
    check(!("embedding" in fetched.body), "get response has no embedding field");
    check(fetched.body.name === smokeRecipe.name, "get returns the stored name");

    // 2b. Requests without the API key are rejected by the gateway. Checked
    // here deterministically because the pinned Schemathesis version cannot:
    // its ignored_auth check accepts only 401, while API Gateway rejects
    // missing keys with 403 by design.
    const noKeyResponse = await fetch(`${apiUrl}/recipes/${recipeId}`, { method: "GET" });
    await noKeyResponse.text();
    check(
      noKeyResponse.status === 403,
      `request without api key returns 403 (got ${noKeyResponse.status})`,
    );

    // 3. Search with a paraphrase sharing no keywords with the recipe text.
    const search = await request("POST", "/recipes/search", {
      query: "hot and hearty poultry dish",
    });
    check(search.status === 200, `search returns 200 (got ${search.status})`);
    const results = (search.body.results ?? []) as SearchResult[];
    const match = results.find((result) => result.recipeId === recipeId);
    check(match !== undefined, "semantic search finds the created recipe");
    check(
      (match?.similarity ?? 0) > SIMILARITY_THRESHOLD,
      `similarity ${match?.similarity ?? "n/a"} is above the ${SIMILARITY_THRESHOLD} threshold`,
    );
    const sorted = results.every(
      (result, index) => index === 0 || results[index - 1]!.similarity >= result.similarity,
    );
    check(sorted, "results are sorted by similarity descending");

    // 3b. Search pagination: a one-result page plus a cursor walk whenever
    // more matches exist in this environment.
    const searchPageOne = await request("POST", "/recipes/search", {
      query: "hot and hearty poultry dish",
      topK: 1,
    });
    check(searchPageOne.status === 200, `paged search returns 200 (got ${searchPageOne.status})`);
    const searchPageOneResults = (searchPageOne.body.results ?? []) as SearchResult[];
    check(searchPageOneResults.length <= 1, "search honors topK=1 as the page size");
    if (typeof searchPageOne.body.nextCursor === "string") {
      const searchPageTwo = await request("POST", "/recipes/search", {
        query: "hot and hearty poultry dish",
        topK: 1,
        cursor: searchPageOne.body.nextCursor,
      });
      check(searchPageTwo.status === 200, `search page 2 returns 200 (got ${searchPageTwo.status})`);
      const searchPageTwoResults = (searchPageTwo.body.results ?? []) as SearchResult[];
      check(
        searchPageTwoResults[0]?.recipeId !== searchPageOneResults[0]?.recipeId,
        "search page 2 starts after page 1",
      );
    }

    // 4. Search with the cuisine filter and assert only that cuisine returns.
    const filtered = await request("POST", "/recipes/search", {
      query: "something spicy",
      cuisine: "mexican",
      topK: 5,
    });
    check(filtered.status === 200, `filtered search returns 200 (got ${filtered.status})`);
    const filteredResults = (filtered.body.results ?? []) as SearchResult[];
    check(
      filteredResults.every((result) => result.cuisine === "mexican"),
      "cuisine filter returns only mexican recipes",
    );

    // 4b. List endpoint: page sizing, no embeddings, cursor walk, bad cursor.
    const listPage = await request("GET", "/recipes?pageSize=1");
    check(listPage.status === 200, `list returns 200 (got ${listPage.status})`);
    const listItems = (listPage.body.items ?? []) as { recipeId?: string }[];
    check(Array.isArray(listPage.body.items), "list returns an items array");
    check(listItems.length === 1, "list honors pageSize=1");
    check(
      listItems.every((item) => !("embedding" in item)),
      "list items have no embedding field",
    );
    if (typeof listPage.body.nextCursor === "string") {
      const listPageTwo = await request(
        "GET",
        `/recipes?pageSize=1&cursor=${encodeURIComponent(listPage.body.nextCursor)}`,
      );
      check(listPageTwo.status === 200, `list page 2 returns 200 (got ${listPageTwo.status})`);
      const listPageTwoItems = (listPageTwo.body.items ?? []) as { recipeId?: string }[];
      check(
        listPageTwoItems[0]?.recipeId !== listItems[0]?.recipeId,
        "list page 2 starts after page 1",
      );
    }
    const badCursor = await request("GET", "/recipes?cursor=not-a-valid-cursor");
    check(badCursor.status === 400, `invalid list cursor returns 400 (got ${badCursor.status})`);

    // 5. Update it and assert 200.
    const updated = await request("PUT", `/recipes/${recipeId}`, {
      ...smokeRecipe,
      description:
        "A fiery, slow-simmered chicken stew with chipotle peppers, charred tomatoes, and a touch of cocoa.",
    });
    check(updated.status === 200, `update returns 200 (got ${updated.status})`);

    // 6. Update a random id and assert 404 (the conditional write at work).
    const ghost = await request("PUT", `/recipes/${randomUUID()}`, smokeRecipe);
    check(ghost.status === 404, `update of a missing recipe returns 404 (got ${ghost.status})`);

    // 7. Delete it.
    const removed = await request("DELETE", `/recipes/${recipeId}`);
    check(removed.status === 200, `delete returns 200 (got ${removed.status})`);
    deleted = removed.status === 200;
  } finally {
    // Best-effort cleanup if an assertion threw before the delete step.
    if (recipeId && !deleted) {
      await request("DELETE", `/recipes/${recipeId}`).catch(() => undefined);
    }
  }

  // The GraphQL leg runs after the REST leg so its paraphrase search cannot
  // match the (already deleted) REST smoke recipe.
  await graphqlChecks();

  if (failures > 0) {
    console.error(`Smoke test failed: ${failures} assertion(s) did not hold`);
    process.exit(1);
  }
  console.log("Smoke test passed");
};

await main();
