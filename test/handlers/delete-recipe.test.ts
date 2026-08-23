import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../functions/delete-recipe/index";
import { apiEvent, parseBody, setHandlerEnv, TEST_UUID } from "./helpers";

const ddbMock = mockClient(DynamoDBClient);

beforeEach(() => {
  ddbMock.reset();
  setHandlerEnv();
});

describe("delete-recipe handler", () => {
  it("deletes via a conditional delete", async () => {
    ddbMock.on(DeleteItemCommand).resolves({});

    const response = await handler(apiEvent({ pathParameters: { recipeId: TEST_UUID } }));

    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body).message).toBe("Recipe deleted");
    const calls = ddbMock.commandCalls(DeleteItemCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.ConditionExpression).toBe("attribute_exists(recipeId)");
  });

  it("maps ConditionalCheckFailedException to 404", async () => {
    ddbMock.on(DeleteItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      }),
    );

    const response = await handler(apiEvent({ pathParameters: { recipeId: TEST_UUID } }));

    expect(response.statusCode).toBe(404);
    expect(parseBody(response.body).error).toBe("Recipe not found");
  });

  it("returns the sanitized 500 body on unexpected errors", async () => {
    ddbMock.on(DeleteItemCommand).rejects(new Error("provisioning internals"));

    const response = await handler(apiEvent({ pathParameters: { recipeId: TEST_UUID } }));

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: "Internal server error" }));
    expect(response.body).not.toContain("provisioning");
  });
});
