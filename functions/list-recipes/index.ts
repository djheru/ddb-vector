import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  badRequest,
  internalError,
  jsonResponse,
  logError,
  logInfo,
  requireEnv,
} from "../shared/http";
import { decodeCursor, encodeCursor } from "../shared/pagination";
import {
  CURSOR_MAX_LENGTH,
  ENTITY_TYPE_RECIPE,
  isRecord,
  LIST_PAGE_SIZE_DEFAULT,
  LIST_PAGE_SIZE_MAX,
  LIST_PAGE_SIZE_MIN,
} from "../shared/types";

const dynamodb = new DynamoDBClient({});

const CURSOR_KEY_FIELDS = ["recipeId", "entityType", "name"] as const;

/**
 * A list cursor is the marshalled LastEvaluatedKey of the list GSI: exactly
 * the table key plus both index keys, all strings. Anything else is rejected
 * before it reaches DynamoDB.
 */
const isListStartKey = (value: unknown): value is Record<string, AttributeValue> =>
  isRecord(value) &&
  Object.keys(value).length === CURSOR_KEY_FIELDS.length &&
  CURSOR_KEY_FIELDS.every((field) => {
    const attribute = value[field];
    return isRecord(attribute) && typeof attribute.S === "string";
  });

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const pageSizeParam = event.queryStringParameters?.pageSize;
    const cursorParam = event.queryStringParameters?.cursor;

    // The gateway does not schema-validate query parameter ranges, so the
    // declared 1-50 bound is enforced here with a 400, not a silent clamp.
    let pageSize = LIST_PAGE_SIZE_DEFAULT;
    if (pageSizeParam !== undefined) {
      const parsed = Number(pageSizeParam);
      if (
        !Number.isInteger(parsed) ||
        parsed < LIST_PAGE_SIZE_MIN ||
        parsed > LIST_PAGE_SIZE_MAX
      ) {
        return badRequest(
          `pageSize must be an integer in range ${LIST_PAGE_SIZE_MIN}-${LIST_PAGE_SIZE_MAX}`,
        );
      }
      pageSize = parsed;
    }

    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    if (cursorParam !== undefined) {
      if (cursorParam.length > CURSOR_MAX_LENGTH) return badRequest("cursor is not valid");
      const decoded = decodeCursor(cursorParam);
      if (!isListStartKey(decoded)) return badRequest("cursor is not valid");
      exclusiveStartKey = decoded;
    }

    const output = await dynamodb.send(
      new QueryCommand({
        TableName: requireEnv("TABLE_NAME"),
        IndexName: requireEnv("LIST_INDEX_NAME"),
        KeyConditionExpression: "entityType = :entityType",
        ExpressionAttributeValues: { ":entityType": { S: ENTITY_TYPE_RECIPE } },
        Limit: pageSize,
        ScanIndexForward: true,
        ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );

    const items = (output.Items ?? []).map((item) => {
      const recipe = unmarshall(item);
      // entityType is an internal index key; the GSI projection excludes the
      // embedding, but strip both defensively.
      delete recipe.entityType;
      delete recipe.embedding;
      return recipe;
    });

    logInfo("recipes listed", { pageSize, count: items.length, hasMore: Boolean(output.LastEvaluatedKey) });
    return jsonResponse(200, {
      items,
      ...(output.LastEvaluatedKey && { nextCursor: encodeCursor(output.LastEvaluatedKey) }),
    });
  } catch (error) {
    logError("failed to list recipes", error);
    return internalError();
  }
};
