import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, SearchVectorsCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../functions/search-recipes/index";
import { apiEvent, embeddingResponse, setHandlerEnv, storedItem, TEST_UUID } from "./helpers";

const ddbMock = mockClient(DynamoDBClient);
const bedrockMock = mockClient(BedrockRuntimeClient);

interface SearchResponseBody {
  query: string;
  cuisine?: string;
  nextCursor?: string;
  results: {
    recipeId: string;
    name: string;
    cuisine?: string;
    similarity: number;
    distance: number;
  }[];
}

const parseSearchBody = (body: string): SearchResponseBody =>
  JSON.parse(body) as SearchResponseBody;

/** Pool of results with strictly ascending scores, so ordering is deterministic. */
const pool = (size: number) =>
  Array.from({ length: size }, (_, index) => ({
    Item: storedItem(
      `650e8400-e29b-41d4-a716-4466554400${String(index).padStart(2, "0")}`,
      `Recipe ${index}`,
      "mexican",
    ),
    Score: 0.1 + index * 0.05,
  }));

beforeEach(() => {
  ddbMock.reset();
  bedrockMock.reset();
  setHandlerEnv();
  bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.1, 0.2, 0.3]));
});

describe("search-recipes handler", () => {
  it("converts a cosine distance of 0.15 into similarity 0.85 and returns both", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({
      SearchResults: [{ Item: storedItem(TEST_UUID, "Spicy Chicken Stew", "mexican"), Score: 0.15 }],
    });

    const response = await handler(apiEvent({ body: { query: "hot and hearty poultry dish" } }));

    expect(response.statusCode).toBe(200);
    const body = parseSearchBody(response.body);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.similarity).toBe(0.85);
    expect(body.results[0]!.distance).toBe(0.15);
    expect(body.results[0]!.recipeId).toBe(TEST_UUID);
  });

  it("drops results whose similarity falls below SIMILARITY_THRESHOLD", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({
      SearchResults: [
        { Item: storedItem(TEST_UUID, "Close Match", "mexican"), Score: 0.15 },
        { Item: storedItem("650e8400-e29b-41d4-a716-446655440111", "Far Match", "italian"), Score: 0.8 },
      ],
    });

    const response = await handler(apiEvent({ body: { query: "stew" } }));

    const body = parseSearchBody(response.body);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.name).toBe("Close Match");
  });

  it("always requests the engine's full candidate pool; topK is the page size", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({ SearchResults: [] });

    await handler(apiEvent({ body: { query: "stew" } }));
    await handler(apiEvent({ body: { query: "stew", topK: 3 } }));
    await handler(apiEvent({ body: { query: "stew", topK: 100 } }));

    for (const call of ddbMock.commandCalls(SearchVectorsCommand)) {
      expect(call.args[0].input.TopK).toBe(100);
    }
  });

  it("slices the pool to the clamped page size and reports nextCursor when more remain", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({ SearchResults: pool(8) });

    const small = parseSearchBody(
      (await handler(apiEvent({ body: { query: "stew", topK: 3 } }))).body,
    );
    expect(small.results).toHaveLength(3);
    expect(small.nextCursor).toBeDefined();

    const wholePool = parseSearchBody(
      (await handler(apiEvent({ body: { query: "stew", topK: 8 } }))).body,
    );
    expect(wholePool.results).toHaveLength(8);
    expect(wholePool.nextCursor).toBeUndefined();

    const clampedLow = parseSearchBody(
      (await handler(apiEvent({ body: { query: "stew", topK: 0 } }))).body,
    );
    expect(clampedLow.results).toHaveLength(1);
  });

  it("pages through the pool with the returned cursor", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({ SearchResults: pool(5) });

    const first = parseSearchBody(
      (await handler(apiEvent({ body: { query: "stew", topK: 2 } }))).body,
    );
    expect(first.results.map((result) => result.name)).toEqual(["Recipe 0", "Recipe 1"]);
    expect(first.nextCursor).toBeDefined();

    const second = parseSearchBody(
      (
        await handler(
          apiEvent({ body: { query: "stew", topK: 2, cursor: first.nextCursor } }),
        )
      ).body,
    );
    expect(second.results.map((result) => result.name)).toEqual(["Recipe 2", "Recipe 3"]);
    expect(second.nextCursor).toBeDefined();

    const third = parseSearchBody(
      (
        await handler(
          apiEvent({ body: { query: "stew", topK: 2, cursor: second.nextCursor } }),
        )
      ).body,
    );
    expect(third.results.map((result) => result.name)).toEqual(["Recipe 4"]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("rejects a cursor issued for a different query or filter", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({ SearchResults: pool(5) });

    const first = parseSearchBody(
      (await handler(apiEvent({ body: { query: "stew", topK: 2 } }))).body,
    );

    const differentQuery = await handler(
      apiEvent({ body: { query: "salad", topK: 2, cursor: first.nextCursor } }),
    );
    expect(differentQuery.statusCode).toBe(400);

    const differentFilter = await handler(
      apiEvent({
        body: { query: "stew", cuisine: "mexican", topK: 2, cursor: first.nextCursor },
      }),
    );
    expect(differentFilter.statusCode).toBe(400);
  });

  it("rejects malformed cursors with 400 before calling Bedrock", async () => {
    const response = await handler(
      apiEvent({ body: { query: "stew", cursor: "!!!garbage!!!" } }),
    );
    expect(response.statusCode).toBe(400);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it("sends SearchConditionExpression only when cuisine is provided", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({ SearchResults: [] });

    await handler(apiEvent({ body: { query: "stew" } }));
    await handler(apiEvent({ body: { query: "stew", cuisine: "mexican" } }));

    const calls = ddbMock.commandCalls(SearchVectorsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input.SearchConditionExpression).toBeUndefined();
    expect(calls[0]!.args[0].input.ExpressionAttributeValues).toBeUndefined();
    expect(calls[1]!.args[0].input.SearchConditionExpression).toBe("cuisine = :cuisine");
    expect(calls[1]!.args[0].input.ExpressionAttributeValues).toEqual({
      ":cuisine": { S: "mexican" },
    });
  });

  it("echoes cuisine in the response body when filtering", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({ SearchResults: [] });

    const response = await handler(
      apiEvent({ body: { query: "stew", cuisine: "mexican" } }),
    );

    const body = parseSearchBody(response.body);
    expect(body.cuisine).toBe("mexican");
    expect(body.results).toEqual([]);
  });

  it("sorts results by similarity descending", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({
      SearchResults: [
        { Item: storedItem("650e8400-e29b-41d4-a716-446655440001", "Mid", "mexican"), Score: 0.3 },
        { Item: storedItem("650e8400-e29b-41d4-a716-446655440002", "Best", "mexican"), Score: 0.05 },
        { Item: storedItem("650e8400-e29b-41d4-a716-446655440003", "Worst", "mexican"), Score: 0.5 },
      ],
    });

    const response = await handler(apiEvent({ body: { query: "stew" } }));

    const body = parseSearchBody(response.body);
    expect(body.results.map((result) => result.name)).toEqual(["Best", "Mid", "Worst"]);
    expect(body.results.map((result) => result.similarity)).toEqual([0.95, 0.7, 0.5]);
  });

  it("embeds the query with the same request shape as write time", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({ SearchResults: [] });

    await handler(apiEvent({ body: { query: "hearty stew" } }));

    const bedrockCalls = bedrockMock.commandCalls(InvokeModelCommand);
    expect(bedrockCalls).toHaveLength(1);
    expect(JSON.parse(bedrockCalls[0]!.args[0].input.body as string)).toEqual({
      inputText: "hearty stew",
      dimensions: 1024,
      normalize: true,
    });
  });

  it("rejects an out-of-contract query with 400", async () => {
    const response = await handler(apiEvent({ body: { query: "x".repeat(1001) } }));
    expect(response.statusCode).toBe(400);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it("maps Bedrock input-validation failures to 400", async () => {
    const validationError = new Error("input too long");
    validationError.name = "ValidationException";
    bedrockMock.on(InvokeModelCommand).rejects(validationError);

    const response = await handler(apiEvent({ body: { query: "stew" } }));

    expect(response.statusCode).toBe(400);
  });

  it("returns the sanitized 500 body on unexpected errors", async () => {
    ddbMock.on(SearchVectorsCommand).rejects(new Error("index shard 7 unavailable"));

    const response = await handler(apiEvent({ body: { query: "stew" } }));

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: "Internal server error" }));
    expect(response.body).not.toContain("shard");
  });
});
