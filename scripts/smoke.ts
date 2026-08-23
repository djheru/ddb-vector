/**
 * End-to-end sanity checks against a deployed environment. Runs in the
 * pipeline's ValidateDev step; the VectorIndex custom resource has already
 * blocked the deployment until the index was ACTIVE, so there are no waits,
 * sleeps, or readiness retries here by design.
 *
 * Usage: API_URL=https://... API_KEY=... npx tsx scripts/smoke.ts
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

  if (failures > 0) {
    console.error(`Smoke test failed: ${failures} assertion(s) did not hold`);
    process.exit(1);
  }
  console.log("Smoke test passed");
};

await main();
