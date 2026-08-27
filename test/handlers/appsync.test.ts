import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  SearchVectorsCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { Context } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../functions/appsync/index";
import type { ResolverEnvelope } from "../../functions/shared/appsync";
import {
  appSyncEvent,
  embeddingResponse,
  setHandlerEnv,
  storedItem,
  TEST_UUID,
  validRecipe,
} from "./helpers";

const ddbMock = mockClient(DynamoDBClient);
const bedrockMock = mockClient(BedrockRuntimeClient);

const invoke = async (
  parentTypeName: "Query" | "Mutation",
  fieldName: string,
  args: Record<string, unknown>,
): Promise<ResolverEnvelope<unknown>> =>
  (await handler(
    appSyncEvent(parentTypeName, fieldName, args),
    {} as Context,
    () => {},
  )) as ResolverEnvelope<unknown>;

const dataOf = (envelope: ResolverEnvelope<unknown>): Record<string, unknown> => {
  if (!("data" in envelope)) throw new Error(`expected data, got ${JSON.stringify(envelope)}`);
  return envelope.data as Record<string, unknown>;
};

const errorOf = (envelope: ResolverEnvelope<unknown>): { message: string; type: string } => {
  if (!("error" in envelope)) throw new Error(`expected error, got ${JSON.stringify(envelope)}`);
  return envelope.error;
};

const conditionalFailure = (): ConditionalCheckFailedException =>
  new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
  });

beforeEach(() => {
  ddbMock.reset();
  bedrockMock.reset();
  setHandlerEnv();
});

describe("appsync lambdalith handler", () => {
  it("resolves Query.getRecipe and strips the embedding", async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        ...storedItem(TEST_UUID, "Spicy Chicken Stew", "mexican"),
        embedding: { L: [{ N: "0.5" }] },
      },
    });

    const data = dataOf(await invoke("Query", "getRecipe", { recipeId: TEST_UUID }));

    expect(data.recipeId).toBe(TEST_UUID);
    expect(data.name).toBe("Spicy Chicken Stew");
    expect(data.embedding).toBeUndefined();
  });

  it("returns a NotFoundError envelope for Query.getRecipe on a missing item", async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const error = errorOf(await invoke("Query", "getRecipe", { recipeId: TEST_UUID }));

    expect(error).toEqual({ type: "NotFoundError", message: "Recipe not found" });
  });

  it("returns a ValidationError envelope for Query.getRecipe with a non-UUID id", async () => {
    const error = errorOf(await invoke("Query", "getRecipe", { recipeId: "nope" }));

    expect(error).toEqual({ type: "ValidationError", message: "recipeId must be a UUID" });
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it("resolves Mutation.createRecipe with a conditional put", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.5, -0.25]));
    ddbMock.on(PutItemCommand).resolves({});

    const data = dataOf(await invoke("Mutation", "createRecipe", { input: validRecipe }));

    expect(data.message).toBe("Recipe created");
    expect(typeof data.recipeId).toBe("string");
    const input = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe("attribute_not_exists(recipeId)");
  });

  it("returns a ValidationError envelope for Mutation.createRecipe with an invalid input", async () => {
    const { name: _name, ...missingName } = validRecipe;

    const error = errorOf(await invoke("Mutation", "createRecipe", { input: missingName }));

    expect(error.type).toBe("ValidationError");
    expect(error.message).toContain("Invalid recipe");
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it("returns a NotFoundError envelope for Mutation.updateRecipe when the conditional write fails", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.5, -0.25]));
    ddbMock.on(PutItemCommand).rejects(conditionalFailure());

    const error = errorOf(
      await invoke("Mutation", "updateRecipe", { recipeId: TEST_UUID, input: validRecipe }),
    );

    expect(error).toEqual({ type: "NotFoundError", message: "Recipe not found" });
  });

  it("resolves Mutation.deleteRecipe", async () => {
    ddbMock.on(DeleteItemCommand).resolves({});

    const data = dataOf(await invoke("Mutation", "deleteRecipe", { recipeId: TEST_UUID }));

    expect(data.message).toBe("Recipe deleted");
  });

  it("resolves Query.searchRecipes and treats a null cuisine as absent", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.5, -0.25]));
    ddbMock.on(SearchVectorsCommand).resolves({
      SearchResults: [
        { Item: storedItem(TEST_UUID, "Spicy Chicken Stew", "mexican"), Score: 0.15 },
      ],
    });

    const data = dataOf(
      await invoke("Query", "searchRecipes", {
        query: "hot and hearty poultry dish",
        cuisine: null,
        topK: null,
        cursor: null,
      }),
    ) as { results: { similarity: number; distance: number }[] };

    expect(data.results).toHaveLength(1);
    expect(data.results[0]!.similarity).toBe(0.85);
    expect(data.results[0]!.distance).toBe(0.15);
    const input = ddbMock.commandCalls(SearchVectorsCommand)[0]!.args[0].input;
    expect(input.SearchConditionExpression).toBeUndefined();
  });

  it("passes the cuisine inline filter through Query.searchRecipes", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.5, -0.25]));
    ddbMock.on(SearchVectorsCommand).resolves({ SearchResults: [] });

    await invoke("Query", "searchRecipes", { query: "something spicy", cuisine: "mexican" });

    const input = ddbMock.commandCalls(SearchVectorsCommand)[0]!.args[0].input;
    expect(input.SearchConditionExpression).toBe("cuisine = :cuisine");
    expect(input.ExpressionAttributeValues).toEqual({ ":cuisine": { S: "mexican" } });
  });

  it("resolves Query.listRecipes with a numeric GraphQL pageSize", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [storedItem(TEST_UUID, "Spicy Chicken Stew", "mexican")],
    });

    const data = dataOf(await invoke("Query", "listRecipes", { pageSize: 10, cursor: null })) as {
      items: unknown[];
    };

    expect(data.items).toHaveLength(1);
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input.Limit).toBe(10);
  });

  it("sanitizes unexpected errors to a generic InternalError envelope", async () => {
    ddbMock.on(GetItemCommand).rejects(new Error("connection pool exhausted: 10.0.0.7"));

    const error = errorOf(await invoke("Query", "getRecipe", { recipeId: TEST_UUID }));

    expect(error).toEqual({ type: "InternalError", message: "Internal server error" });
  });

  it("sanitizes unknown fields to a generic InternalError envelope", async () => {
    const error = errorOf(await invoke("Query", "definitelyNotAField", {}));

    expect(error).toEqual({ type: "InternalError", message: "Internal server error" });
  });
});
