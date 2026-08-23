import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../functions/get-recipe/index";
import { apiEvent, parseBody, setHandlerEnv, storedItem, TEST_UUID } from "./helpers";

const ddbMock = mockClient(DynamoDBClient);

beforeEach(() => {
  ddbMock.reset();
  setHandlerEnv();
});

describe("get-recipe handler", () => {
  it("returns the recipe with the embedding field stripped", async () => {
    const item = {
      ...storedItem(TEST_UUID, "Spicy Chicken Stew", "mexican"),
      embedding: { L: [{ N: "0.5" }, { N: "-0.25" }] },
    };
    ddbMock.on(GetItemCommand).resolves({ Item: item });

    const response = await handler(apiEvent({ pathParameters: { recipeId: TEST_UUID } }));

    expect(response.statusCode).toBe(200);
    const body = parseBody(response.body);
    expect(body.recipeId).toBe(TEST_UUID);
    expect(body.name).toBe("Spicy Chicken Stew");
    expect(body).not.toHaveProperty("embedding");
    expect(response.body).not.toContain("embedding");
  });

  it("returns 404 when the item is absent", async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const response = await handler(apiEvent({ pathParameters: { recipeId: TEST_UUID } }));

    expect(response.statusCode).toBe(404);
    expect(parseBody(response.body).error).toBe("Recipe not found");
  });

  it("rejects a non-UUID path parameter with 400", async () => {
    const response = await handler(apiEvent({ pathParameters: { recipeId: "not-a-uuid" } }));
    expect(response.statusCode).toBe(400);
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it("returns the sanitized 500 body on unexpected errors", async () => {
    ddbMock.on(GetItemCommand).rejects(new Error("internal table details leaked"));

    const response = await handler(apiEvent({ pathParameters: { recipeId: TEST_UUID } }));

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: "Internal server error" }));
    expect(response.body).not.toContain("leaked");
  });
});
