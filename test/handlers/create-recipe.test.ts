import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../functions/create-recipe/index";
import { apiEvent, embeddingResponse, parseBody, setHandlerEnv, validRecipe } from "./helpers";

const ddbMock = mockClient(DynamoDBClient);
const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  ddbMock.reset();
  bedrockMock.reset();
  setHandlerEnv();
});

describe("create-recipe handler", () => {
  it("creates a recipe with a conditional put and the embedding stored as a number list", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.5, -0.25]));
    ddbMock.on(PutItemCommand).resolves({});

    const response = await handler(apiEvent({ body: validRecipe }));

    expect(response.statusCode).toBe(201);
    const body = parseBody(response.body);
    expect(body.message).toBe("Recipe created");
    expect(typeof body.recipeId).toBe("string");

    const calls = ddbMock.commandCalls(PutItemCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.ConditionExpression).toBe("attribute_not_exists(recipeId)");
    expect(input.Item?.embedding).toEqual({ L: [{ N: "0.5" }, { N: "-0.25" }] });
    expect(input.Item?.name).toEqual({ S: "Spicy Chicken Stew" });
  });

  it("rejects an invalid recipe with 400 before calling Bedrock", async () => {
    const { name: _name, ...missingName } = validRecipe;
    const response = await handler(apiEvent({ body: missingName }));

    expect(response.statusCode).toBe(400);
    expect(parseBody(response.body).error).toContain("name");
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const response = await handler(apiEvent({ rawBody: "{not json" }));
    expect(response.statusCode).toBe(400);
  });

  it("returns the sanitized 500 body when the write fails unexpectedly", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(embeddingResponse([0.5]));
    ddbMock.on(PutItemCommand).rejects(new Error("connection pool exhausted at 10.0.0.5"));

    const response = await handler(apiEvent({ body: validRecipe }));

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: "Internal server error" }));
    expect(response.body).not.toContain("connection pool");
  });

  it("maps a Bedrock validation failure to 400", async () => {
    const validationError = new Error("input too long");
    validationError.name = "ValidationException";
    bedrockMock.on(InvokeModelCommand).rejects(validationError);

    const response = await handler(apiEvent({ body: validRecipe }));

    expect(response.statusCode).toBe(400);
    expect(parseBody(response.body).error).toBe("Recipe text could not be embedded");
  });
});
