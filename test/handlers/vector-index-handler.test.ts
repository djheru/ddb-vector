import {
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler as isCompleteHandler } from "../../custom-resources/vector-index-handler/is-complete";
import {
  handler as onEventHandler,
  IMMUTABLE_CONFIG_MESSAGE,
} from "../../custom-resources/vector-index-handler/on-event";
import type { VectorIndexProperties } from "../../custom-resources/vector-index-handler/on-event";

const ddbMock = mockClient(DynamoDBClient);

const baseProps: VectorIndexProperties = {
  ServiceToken: "arn:aws:lambda:us-east-1:111111111111:function:provider",
  TableName: "Recipes",
  IndexName: "RecipeEmbeddingIndex",
  VectorAttributeName: "embedding",
  Dimensions: "1024",
  DistanceFunction: "COSINE",
  InlineFilterAttributes: [{ name: "cuisine", type: "S" }],
  ProjectionType: "ALL",
};

const tableNotFound = (): ResourceNotFoundException =>
  new ResourceNotFoundException({ message: "Requested resource not found", $metadata: {} });

beforeEach(() => {
  ddbMock.reset();
});

describe("on-event Create", () => {
  it("calls UpdateTable with the exact vector index creation shape", async () => {
    ddbMock.on(UpdateTableCommand).resolves({});

    const result = await onEventHandler({ RequestType: "Create", ResourceProperties: baseProps });

    expect(result.PhysicalResourceId).toBe("RecipeEmbeddingIndex");
    const calls = ddbMock.commandCalls(UpdateTableCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.TableName).toBe("Recipes");
    expect(input.AttributeDefinitions).toEqual([
      { AttributeName: "cuisine", AttributeType: "S" },
    ]);
    expect(input.VectorIndexUpdates).toEqual([
      {
        Create: {
          IndexName: "RecipeEmbeddingIndex",
          VectorAttribute: { AttributeName: "embedding" },
          SearchSchema: [{ AttributeName: "cuisine", SearchSchemaElementType: "INLINE_FILTER" }],
          Projection: { ProjectionType: "ALL" },
          Dimensions: 1024,
          DistanceFunction: "COSINE",
        },
      },
    ]);
  });

  it("treats an already-existing index as success on retry", async () => {
    ddbMock.on(UpdateTableCommand).rejects(new Error("Vector index already exists"));
    ddbMock.on(DescribeTableCommand).resolves({
      Table: { VectorIndexes: [{ IndexName: "RecipeEmbeddingIndex", IndexStatus: "CREATING" }] },
    });

    const result = await onEventHandler({ RequestType: "Create", ResourceProperties: baseProps });
    expect(result.PhysicalResourceId).toBe("RecipeEmbeddingIndex");
  });

  it("rethrows a create failure when the index does not actually exist", async () => {
    ddbMock.on(UpdateTableCommand).rejects(new Error("LimitExceededException"));
    ddbMock.on(DescribeTableCommand).resolves({ Table: { VectorIndexes: [] } });

    await expect(
      onEventHandler({ RequestType: "Create", ResourceProperties: baseProps }),
    ).rejects.toThrow("LimitExceededException");
  });
});

describe("on-event Update", () => {
  it("throws the immutability error when config changes under the same index name", async () => {
    await expect(
      onEventHandler({
        RequestType: "Update",
        PhysicalResourceId: "RecipeEmbeddingIndex",
        ResourceProperties: { ...baseProps, Dimensions: "512" },
        OldResourceProperties: baseProps,
      }),
    ).rejects.toThrow(IMMUTABLE_CONFIG_MESSAGE);
    expect(ddbMock.commandCalls(UpdateTableCommand)).toHaveLength(0);
  });

  it("creates the replacement index when indexName changes", async () => {
    ddbMock.on(UpdateTableCommand).resolves({});

    const result = await onEventHandler({
      RequestType: "Update",
      PhysicalResourceId: "RecipeEmbeddingIndex",
      ResourceProperties: { ...baseProps, IndexName: "RecipeEmbeddingIndexV2", Dimensions: "512" },
      OldResourceProperties: baseProps,
    });

    expect(result.PhysicalResourceId).toBe("RecipeEmbeddingIndexV2");
    const calls = ddbMock.commandCalls(UpdateTableCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.VectorIndexUpdates?.[0]?.Create?.IndexName).toBe(
      "RecipeEmbeddingIndexV2",
    );
    expect(calls[0]!.args[0].input.VectorIndexUpdates?.[0]?.Create?.Dimensions).toBe(512);
  });

  it("no-ops when nothing material changed", async () => {
    const result = await onEventHandler({
      RequestType: "Update",
      PhysicalResourceId: "RecipeEmbeddingIndex",
      ResourceProperties: { ...baseProps },
      OldResourceProperties: { ...baseProps },
    });

    expect(result.PhysicalResourceId).toBe("RecipeEmbeddingIndex");
    expect(ddbMock.commandCalls(UpdateTableCommand)).toHaveLength(0);
  });
});

describe("on-event Delete", () => {
  it("deletes the index named by the physical resource id", async () => {
    ddbMock.on(UpdateTableCommand).resolves({});

    await onEventHandler({
      RequestType: "Delete",
      PhysicalResourceId: "OldIndexName",
      ResourceProperties: baseProps,
    });

    const calls = ddbMock.commandCalls(UpdateTableCommand);
    expect(calls[0]!.args[0].input.VectorIndexUpdates).toEqual([
      { Delete: { IndexName: "OldIndexName" } },
    ]);
  });

  it("swallows ResourceNotFoundException so teardown never wedges", async () => {
    ddbMock.on(UpdateTableCommand).rejects(tableNotFound());

    await expect(
      onEventHandler({
        RequestType: "Delete",
        PhysicalResourceId: "RecipeEmbeddingIndex",
        ResourceProperties: baseProps,
      }),
    ).resolves.toEqual({ PhysicalResourceId: "RecipeEmbeddingIndex" });
  });

  it("swallows index-does-not-exist validation errors", async () => {
    ddbMock.on(UpdateTableCommand).rejects(new Error("Vector index does not exist: RecipeEmbeddingIndex"));

    await expect(
      onEventHandler({
        RequestType: "Delete",
        PhysicalResourceId: "RecipeEmbeddingIndex",
        ResourceProperties: baseProps,
      }),
    ).resolves.toBeDefined();
  });

  it("rethrows unrelated delete failures", async () => {
    ddbMock.on(UpdateTableCommand).rejects(new Error("AccessDeniedException"));

    await expect(
      onEventHandler({
        RequestType: "Delete",
        PhysicalResourceId: "RecipeEmbeddingIndex",
        ResourceProperties: baseProps,
      }),
    ).rejects.toThrow("AccessDeniedException");
  });
});

describe("is-complete", () => {
  it("is complete when the index is ACTIVE with no backfill", async () => {
    ddbMock.on(DescribeTableCommand).resolves({
      Table: { VectorIndexes: [{ IndexName: "RecipeEmbeddingIndex", IndexStatus: "ACTIVE" }] },
    });

    const result = await isCompleteHandler({
      RequestType: "Create",
      PhysicalResourceId: "RecipeEmbeddingIndex",
      ResourceProperties: baseProps,
    });
    expect(result.IsComplete).toBe(true);
  });

  it("is not complete while the index is still creating", async () => {
    ddbMock.on(DescribeTableCommand).resolves({
      Table: { VectorIndexes: [{ IndexName: "RecipeEmbeddingIndex", IndexStatus: "CREATING" }] },
    });

    const result = await isCompleteHandler({
      RequestType: "Create",
      PhysicalResourceId: "RecipeEmbeddingIndex",
      ResourceProperties: baseProps,
    });
    expect(result.IsComplete).toBe(false);
  });

  it("is not complete while a backfill is in progress even if ACTIVE", async () => {
    ddbMock.on(DescribeTableCommand).resolves({
      Table: {
        VectorIndexes: [
          { IndexName: "RecipeEmbeddingIndex", IndexStatus: "ACTIVE", Backfilling: true },
        ],
      },
    });

    const result = await isCompleteHandler({
      RequestType: "Create",
      PhysicalResourceId: "RecipeEmbeddingIndex",
      ResourceProperties: baseProps,
    });
    expect(result.IsComplete).toBe(false);
  });

  it("delete is complete when the index is absent", async () => {
    ddbMock.on(DescribeTableCommand).resolves({ Table: { VectorIndexes: [] } });

    const result = await isCompleteHandler({
      RequestType: "Delete",
      PhysicalResourceId: "RecipeEmbeddingIndex",
      ResourceProperties: baseProps,
    });
    expect(result.IsComplete).toBe(true);
  });

  it("delete is complete when the table itself is gone", async () => {
    ddbMock.on(DescribeTableCommand).rejects(tableNotFound());

    const result = await isCompleteHandler({
      RequestType: "Delete",
      PhysicalResourceId: "RecipeEmbeddingIndex",
      ResourceProperties: baseProps,
    });
    expect(result.IsComplete).toBe(true);
  });

  it("propagates describe failures during create so the provider retries", async () => {
    ddbMock.on(DescribeTableCommand).rejects(tableNotFound());

    await expect(
      isCompleteHandler({
        RequestType: "Create",
        PhysicalResourceId: "RecipeEmbeddingIndex",
        ResourceProperties: baseProps,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});
