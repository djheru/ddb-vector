import { fileURLToPath } from "node:url";
import { CustomResource, Duration } from "aws-cdk-lib";
import type { RemovalPolicy } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import type { RetentionDays } from "aws-cdk-lib/aws-logs";
import { Provider } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { lambdaBundling } from "../lambda-defaults";

export interface InlineFilterAttribute {
  readonly name: string;
  readonly type: "S" | "N";
}

export interface VectorIndexProps {
  readonly table: ITable;
  readonly indexName: string;
  readonly vectorAttributeName: string;
  readonly dimensions: number;
  readonly distanceFunction: "COSINE" | "EUCLIDEAN" | "DOT_PRODUCT";
  readonly inlineFilterAttributes: InlineFilterAttribute[];
  readonly projectionType: "ALL" | "KEYS_ONLY";
  readonly logRetention: RetentionDays;
  readonly logRemovalPolicy: RemovalPolicy;
}

const HANDLER_MEMORY_MB = 256;

/**
 * Creates a DynamoDB vector index out-of-band via UpdateTable, because
 * CloudFormation has no VectorIndexes property on AWS::DynamoDB::Table yet.
 *
 * The provider polls DescribeTable until the index reports IndexStatus ACTIVE
 * with no backfill, so a deployment does not report success until the index is
 * actually queryable. PhysicalResourceId is the index name, which gives
 * correct replacement semantics: renaming the index creates the new one first
 * and CloudFormation then deletes the old physical id.
 */
export class VectorIndex extends Construct {
  readonly customResource: CustomResource;

  constructor(scope: Construct, id: string, props: VectorIndexProps) {
    super(scope, id);

    const entry = (file: string): string =>
      fileURLToPath(new URL(`../../custom-resources/vector-index-handler/${file}`, import.meta.url));

    const onEvent = new NodejsFunction(this, "OnEvent", {
      entry: entry("on-event.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: HANDLER_MEMORY_MB,
      timeout: Duration.minutes(2),
      bundling: lambdaBundling,
      logGroup: new LogGroup(this, "OnEventLogs", {
        retention: props.logRetention,
        removalPolicy: props.logRemovalPolicy,
      }),
    });
    onEvent.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:UpdateTable", "dynamodb:DescribeTable"],
        resources: [props.table.tableArn],
      }),
    );

    const isComplete = new NodejsFunction(this, "IsComplete", {
      entry: entry("is-complete.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: HANDLER_MEMORY_MB,
      timeout: Duration.seconds(30),
      bundling: lambdaBundling,
      logGroup: new LogGroup(this, "IsCompleteLogs", {
        retention: props.logRetention,
        removalPolicy: props.logRemovalPolicy,
      }),
    });
    isComplete.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:DescribeTable"],
        resources: [props.table.tableArn],
      }),
    );

    const provider = new Provider(this, "Provider", {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      queryInterval: Duration.seconds(15),
      // Backfill on a pre-populated table can take a while; fresh tables are fast.
      totalTimeout: Duration.minutes(30),
      logGroup: new LogGroup(this, "ProviderLogs", {
        retention: props.logRetention,
        removalPolicy: props.logRemovalPolicy,
      }),
    });

    // Every config value is a property so CloudFormation detects changes.
    this.customResource = new CustomResource(this, "Resource", {
      serviceToken: provider.serviceToken,
      resourceType: "Custom::DynamoDBVectorIndex",
      properties: {
        TableName: props.table.tableName,
        IndexName: props.indexName,
        VectorAttributeName: props.vectorAttributeName,
        Dimensions: props.dimensions,
        DistanceFunction: props.distanceFunction,
        InlineFilterAttributes: props.inlineFilterAttributes,
        ProjectionType: props.projectionType,
      },
    });
  }
}
