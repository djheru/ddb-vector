import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../functions/list-recipes/index";
import { encodeCursor } from "../../functions/shared/pagination";
import { apiEvent, parseBody, setHandlerEnv, storedItem, TEST_UUID } from "./helpers";

const ddbMock = mockClient(DynamoDBClient);

const listedItem = (
  recipeId: string,
  name: string,
): Record<string, AttributeValue> => ({
  ...storedItem(recipeId, name, "mexican"),
  entityType: { S: "RECIPE" },
});

const lastEvaluatedKey = (recipeId: string, name: string): Record<string, AttributeValue> => ({
  recipeId: { S: recipeId },
  entityType: { S: "RECIPE" },
  name: { S: name },
});

interface ListBody {
  items: Record<string, unknown>[];
  nextCursor?: string;
}

beforeEach(() => {
  ddbMock.reset();
  setHandlerEnv();
});

describe("list-recipes handler", () => {
  it("queries the list index and strips internal fields from items", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [listedItem(TEST_UUID, "Spicy Chicken Stew")] });

    const response = await handler(apiEvent({}));

    expect(response.statusCode).toBe(200);
    const body = parseBody(response.body) as unknown as ListBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.recipeId).toBe(TEST_UUID);
    expect(body.items[0]).not.toHaveProperty("entityType");
    expect(body.items[0]).not.toHaveProperty("embedding");
    expect(body.nextCursor).toBeUndefined();

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.IndexName).toBe("RecipeListIndex");
    expect(input.KeyConditionExpression).toBe("entityType = :entityType");
    expect(input.ExpressionAttributeValues).toEqual({ ":entityType": { S: "RECIPE" } });
    expect(input.Limit).toBe(20);
    expect(input.ExclusiveStartKey).toBeUndefined();
  });

  it("returns a nextCursor that round-trips into ExclusiveStartKey", async () => {
    const key = lastEvaluatedKey(TEST_UUID, "Spicy Chicken Stew");
    ddbMock.on(QueryCommand).resolves({
      Items: [listedItem(TEST_UUID, "Spicy Chicken Stew")],
      LastEvaluatedKey: key,
    });

    const firstPage = await handler(apiEvent({ queryStringParameters: { pageSize: "1" } }));
    const cursor = (parseBody(firstPage.body) as unknown as ListBody).nextCursor;
    expect(cursor).toBeDefined();

    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const secondPage = await handler(
      apiEvent({ queryStringParameters: { pageSize: "1", cursor: cursor! } }),
    );

    expect(secondPage.statusCode).toBe(200);
    const secondInput = ddbMock.commandCalls(QueryCommand)[1]!.args[0].input;
    expect(secondInput.ExclusiveStartKey).toEqual(key);
    expect(secondInput.Limit).toBe(1);
  });

  it("rejects out-of-range or non-integer pageSize with 400", async () => {
    for (const pageSize of ["0", "51", "abc", "2.5"]) {
      const response = await handler(apiEvent({ queryStringParameters: { pageSize } }));
      expect(response.statusCode, `pageSize=${pageSize}`).toBe(400);
    }
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("rejects malformed and wrong-shaped cursors with 400", async () => {
    for (const cursor of [
      "!!!garbage!!!",
      encodeCursor({ anything: "else" }),
      encodeCursor({ recipeId: { S: "x" }, entityType: { S: "RECIPE" } }),
      encodeCursor([1, 2, 3]),
    ]) {
      const response = await handler(apiEvent({ queryStringParameters: { cursor } }));
      expect(response.statusCode, `cursor=${cursor}`).toBe(400);
    }
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("returns the sanitized 500 body on unexpected errors", async () => {
    ddbMock.on(QueryCommand).rejects(new Error("partition metadata leak"));

    const response = await handler(apiEvent({}));

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: "Internal server error" }));
    expect(response.body).not.toContain("partition");
  });
});
