import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../functions/update-recipe/index";
import { apiEvent, embeddingResponse, parseBody, setHandlerEnv, TEST_UUID, validRecipe } from "./helpers";

const ddbMock = mockClient(DynamoDBClient);
const bedrockMock = mockClient(BedrockRuntimeClient);

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

describe("update-recipe handler", () => {
  it("updates via a single conditional put and never issues a GetItem", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.5]));
    ddbMock.on(PutItemCommand).resolves({});

    const response = await handler(
      apiEvent({ body: validRecipe, pathParameters: { recipeId: TEST_UUID } }),
    );

    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body)).toEqual({ recipeId: TEST_UUID, message: "Recipe updated" });

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.args[0].input.ConditionExpression).toBe("attribute_exists(recipeId)");
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it("maps ConditionalCheckFailedException to 404", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.5]));
    ddbMock.on(PutItemCommand).rejects(conditionalFailure());

    const response = await handler(
      apiEvent({ body: validRecipe, pathParameters: { recipeId: TEST_UUID } }),
    );

    expect(response.statusCode).toBe(404);
    expect(parseBody(response.body).error).toBe("Recipe not found");
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it("rejects an invalid body with 400 before any AWS call", async () => {
    const response = await handler(
      apiEvent({ body: { name: "x" }, pathParameters: { recipeId: TEST_UUID } }),
    );

    expect(response.statusCode).toBe(400);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it("returns the sanitized 500 body on unexpected errors", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.5]));
    ddbMock.on(PutItemCommand).rejects(new Error("secret internal state"));

    const response = await handler(
      apiEvent({ body: validRecipe, pathParameters: { recipeId: TEST_UUID } }),
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: "Internal server error" }));
    expect(response.body).not.toContain("secret");
  });
});
