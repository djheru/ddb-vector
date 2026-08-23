import {
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import type {
  AttributeDefinition,
  CreateVectorIndexAction,
  Projection,
  SearchSchemaElement,
} from "@aws-sdk/client-dynamodb";

const dynamodb = new DynamoDBClient({});

export interface InlineFilterAttribute {
  name: string;
  type: string;
}

/**
 * CloudFormation stringifies scalar custom resource properties, so Dimensions
 * arrives as a string and must be re-parsed before it hits the API.
 */
export interface VectorIndexProperties {
  ServiceToken?: string;
  TableName: string;
  IndexName: string;
  VectorAttributeName: string;
  Dimensions: string | number;
  DistanceFunction: string;
  InlineFilterAttributes?: InlineFilterAttribute[];
  ProjectionType: string;
}

export interface OnEventRequest {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: VectorIndexProperties;
  OldResourceProperties?: VectorIndexProperties;
}

export interface OnEventResponse {
  PhysicalResourceId: string;
}

export const IMMUTABLE_CONFIG_MESSAGE =
  "Vector index configuration is immutable (dimensions, distance function, projection, filters). Change indexName to force replacement.";

const log = (msg: string, context: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ level: "info", msg, ...context }));
};

const indexExists = async (tableName: string, indexName: string): Promise<boolean> => {
  const output = await dynamodb.send(new DescribeTableCommand({ TableName: tableName }));
  return (output.Table?.VectorIndexes ?? []).some((index) => index.IndexName === indexName);
};

const createIndex = async (props: VectorIndexProperties): Promise<void> => {
  const filters = props.InlineFilterAttributes ?? [];
  try {
    await dynamodb.send(
      new UpdateTableCommand({
        TableName: props.TableName,
        ...(filters.length > 0 && {
          AttributeDefinitions: filters.map((filter) => ({
            AttributeName: filter.name,
            AttributeType: filter.type as AttributeDefinition["AttributeType"],
          })),
        }),
        VectorIndexUpdates: [
          {
            Create: {
              IndexName: props.IndexName,
              VectorAttribute: { AttributeName: props.VectorAttributeName },
              ...(filters.length > 0 && {
                SearchSchema: filters.map(
                  (filter): SearchSchemaElement => ({
                    AttributeName: filter.name,
                    SearchSchemaElementType:
                      "INLINE_FILTER" as SearchSchemaElement["SearchSchemaElementType"],
                  }),
                ),
              }),
              Projection: { ProjectionType: props.ProjectionType as Projection["ProjectionType"] },
              Dimensions: Number(props.Dimensions),
              DistanceFunction:
                props.DistanceFunction as CreateVectorIndexAction["DistanceFunction"],
            },
          },
        ],
      }),
    );
    log("vector index create requested", {
      indexName: props.IndexName,
      tableName: props.TableName,
    });
  } catch (error) {
    // Retry after a partial failure: an index already existing under this name
    // is success, not an error.
    const alreadyExists = await indexExists(props.TableName, props.IndexName).catch(() => false);
    if (!alreadyExists) throw error;
    log("vector index already exists, treating create as success", {
      indexName: props.IndexName,
    });
  }
};

/** Everything except the index name; any change here requires replacement. */
const normalizeMaterialConfig = (props: VectorIndexProperties): string =>
  JSON.stringify({
    tableName: props.TableName,
    vectorAttributeName: props.VectorAttributeName,
    dimensions: Number(props.Dimensions),
    distanceFunction: props.DistanceFunction,
    inlineFilterAttributes: (props.InlineFilterAttributes ?? []).map((filter) => ({
      name: filter.name,
      type: filter.type,
    })),
    projectionType: props.ProjectionType,
  });

const isNotFoundError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "ResourceNotFoundException" || /not (found|exist)/i.test(error.message));

export const handler = async (event: OnEventRequest): Promise<OnEventResponse> => {
  const props = event.ResourceProperties;

  switch (event.RequestType) {
    case "Create": {
      await createIndex(props);
      return { PhysicalResourceId: props.IndexName };
    }

    case "Update": {
      const oldProps = event.OldResourceProperties;
      if (oldProps && props.IndexName === oldProps.IndexName) {
        if (normalizeMaterialConfig(props) !== normalizeMaterialConfig(oldProps)) {
          throw new Error(IMMUTABLE_CONFIG_MESSAGE);
        }
        log("no material change to vector index, no-op", { indexName: props.IndexName });
        return { PhysicalResourceId: props.IndexName };
      }
      // Renamed: create the replacement now; CloudFormation follows up with a
      // Delete for the old physical id, which removes the old index.
      await createIndex(props);
      return { PhysicalResourceId: props.IndexName };
    }

    case "Delete": {
      const indexName = event.PhysicalResourceId ?? props.IndexName;
      try {
        await dynamodb.send(
          new UpdateTableCommand({
            TableName: props.TableName,
            VectorIndexUpdates: [{ Delete: { IndexName: indexName } }],
          }),
        );
        log("vector index delete requested", { indexName, tableName: props.TableName });
      } catch (error) {
        // Missing index or missing table must never wedge a stack teardown.
        if (!isNotFoundError(error)) throw error;
        log("vector index or table already gone, delete is a no-op", { indexName });
      }
      return { PhysicalResourceId: indexName };
    }
  }
};
