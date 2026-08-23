import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { TableDescription, VectorIndexDescription } from "@aws-sdk/client-dynamodb";
import type { OnEventRequest } from "./on-event";

const dynamodb = new DynamoDBClient({});

export interface IsCompleteRequest extends OnEventRequest {
  PhysicalResourceId: string;
}

export interface IsCompleteResponse {
  IsComplete: boolean;
}

/**
 * The pinned SDK types the vector index list as TableDescription.VectorIndexes.
 * Keep a defensive fallback scan (arrays whose entries carry IndexName and
 * IndexStatus) in case type definitions and the wire format ever drift; no
 * other field names are guessed.
 */
const listVectorIndexes = (table: TableDescription): VectorIndexDescription[] => {
  if (Array.isArray(table.VectorIndexes)) return table.VectorIndexes;
  return Object.values(table as Record<string, unknown>)
    .filter((value): value is unknown[] => Array.isArray(value))
    .flat()
    .filter(
      (entry): entry is VectorIndexDescription =>
        typeof entry === "object" && entry !== null && "IndexName" in entry && "IndexStatus" in entry,
    );
};

export const handler = async (event: IsCompleteRequest): Promise<IsCompleteResponse> => {
  const props = event.ResourceProperties;
  const indexName = event.PhysicalResourceId ?? props.IndexName;

  let table: TableDescription | undefined;
  try {
    const output = await dynamodb.send(new DescribeTableCommand({ TableName: props.TableName }));
    table = output.Table;
  } catch (error) {
    if (
      event.RequestType === "Delete" &&
      error instanceof Error &&
      error.name === "ResourceNotFoundException"
    ) {
      // The table itself is gone; there is nothing left to wait for.
      return { IsComplete: true };
    }
    throw error;
  }

  // The raw describe output is logged on every poll (the handler is stateless,
  // so a literal "first poll" cannot be detected) to keep any type/wire
  // mismatch diagnosable from the logs.
  console.log(
    JSON.stringify({
      level: "info",
      msg: "describe-table poll",
      requestType: event.RequestType,
      indexName,
      table,
    }),
  );

  const entry = listVectorIndexes(table ?? {}).find((index) => index.IndexName === indexName);

  if (event.RequestType === "Delete") {
    return { IsComplete: entry === undefined };
  }

  // Table status returns to ACTIVE while the index is still building; the
  // index's own status, with no backfill in progress, is the readiness signal.
  return { IsComplete: entry?.IndexStatus === "ACTIVE" && entry.Backfilling !== true };
};
