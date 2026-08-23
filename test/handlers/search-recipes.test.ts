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

  it("clamps topK to 25 when a larger value is requested", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({ SearchResults: [] });

    await handler(apiEvent({ body: { query: "stew", topK: 100 } }));

    const calls = ddbMock.commandCalls(SearchVectorsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.TopK).toBe(25);
  });

  it("defaults topK to 5 and clamps a low value up to 1", async () => {
    ddbMock.on(SearchVectorsCommand).resolves({ SearchResults: [] });

    await handler(apiEvent({ body: { query: "stew" } }));
    await handler(apiEvent({ body: { query: "stew", topK: 0 } }));

    const calls = ddbMock.commandCalls(SearchVectorsCommand);
    expect(calls[0]!.args[0].input.TopK).toBe(5);
    expect(calls[1]!.args[0].input.TopK).toBe(1);
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
