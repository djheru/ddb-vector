import type { StackProps } from "aws-cdk-lib";
import { CfnOutput, Duration, Expiration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { ApiDefinition, Period, SpecRestApi } from "aws-cdk-lib/aws-apigateway";
import {
  AuthorizationType,
  Code,
  Definition,
  FunctionRuntime,
  GraphqlApi,
} from "aws-cdk-lib/aws-appsync";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { load } from "js-yaml";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EMBEDDING_DIMENSIONS } from "../functions/shared/types";
import { VectorIndex } from "./constructs/vector-index";
import { lambdaBundling } from "./lambda-defaults";

export type StageName = "dev" | "prod";

export interface RecipecatalogStackProps extends StackProps {
  readonly stage: StageName;
  readonly embeddingModelId?: string;
}

export const DEFAULT_EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";

const VECTOR_INDEX_NAME = "RecipeEmbeddingIndex";
const VECTOR_ATTRIBUTE_NAME = "embedding";
const LIST_INDEX_NAME = "RecipeListIndex";
// Everything a list item needs except the embedding, which stays out of the
// GSI so the heavy vectors are never duplicated into it.
const LIST_INDEX_PROJECTED_ATTRIBUTES = [
  "cuisine",
  "description",
  "dietary",
  "prepTimeMinutes",
  "cookTimeMinutes",
  "servings",
  "ingredients",
  "steps",
];
// Calibrated to Titan Text Embeddings V2's compressed cosine range: measured
// cross-vocabulary paraphrase matches score ~0.21-0.26 similarity, so 0.3
// silently drops them; 0.15 keeps them while still cutting noise-level hits.
const DEFAULT_SIMILARITY_THRESHOLD = "0.15";
const LAMBDA_MEMORY_MB = 256;
const LAMBDA_TIMEOUT_SECONDS = 15;
const STAGE_THROTTLE_RATE = 20;
const STAGE_THROTTLE_BURST = 40;
const USAGE_PLAN_THROTTLE_RATE = 10;
const USAGE_PLAN_THROTTLE_BURST = 20;
const USAGE_PLAN_DAILY_QUOTA = 10_000;

const substitutePlaceholders = (
  node: unknown,
  replacements: Record<string, string>,
): unknown => {
  if (typeof node === "string") {
    return Object.entries(replacements).reduce(
      (value, [placeholder, replacement]) =>
        value.split(placeholder).join(replacement),
      node,
    );
  }
  if (Array.isArray(node)) {
    return node.map((item) => substitutePlaceholders(item, replacements));
  }
  if (typeof node === "object" && node !== null) {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        substitutePlaceholders(value, replacements),
      ]),
    );
  }
  return node;
};

export class RecipecatalogStack extends Stack {
  readonly apiUrl: CfnOutput;
  readonly apiKeyId: CfnOutput;
  readonly graphqlUrl: CfnOutput;
  readonly graphqlApiId: CfnOutput;

  constructor(scope: Construct, id: string, props: RecipecatalogStackProps) {
    super(scope, id, props);

    const isProd = props.stage === "prod";
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const logRetention = isProd
      ? RetentionDays.ONE_MONTH
      : RetentionDays.TWO_WEEKS;
    const embeddingModelId =
      props.embeddingModelId ?? DEFAULT_EMBEDDING_MODEL_ID;

    const table = new Table(this, "RecipesTable", {
      partitionKey: { name: "recipeId", type: AttributeType.STRING },
      // Vector indexes require on-demand capacity mode.
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      deletionProtection: isProd,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
    });

    // Sparse list index: every recipe carries entityType = "RECIPE", giving a
    // scan-free, name-ordered listing. Items written before this index existed
    // lack the attribute and stay invisible to the list until re-written.
    table.addGlobalSecondaryIndex({
      indexName: LIST_INDEX_NAME,
      partitionKey: { name: "entityType", type: AttributeType.STRING },
      sortKey: { name: "name", type: AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: LIST_INDEX_PROJECTED_ATTRIBUTES,
    });

    const makeFunction = (
      id: string,
      dir: string,
      environment: Record<string, string>,
    ): NodejsFunction =>
      new NodejsFunction(this, id, {
        entry: fileURLToPath(
          new URL(`../functions/${dir}/index.ts`, import.meta.url),
        ),
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        memorySize: LAMBDA_MEMORY_MB,
        timeout: Duration.seconds(LAMBDA_TIMEOUT_SECONDS),
        bundling: lambdaBundling,
        environment,
        logGroup: new LogGroup(this, `${id}Logs`, {
          retention: logRetention,
          removalPolicy,
        }),
      });

    const embeddingEnv = { EMBEDDING_MODEL_ID: embeddingModelId };
    const createRecipeFunction = makeFunction(
      "CreateRecipeFunction",
      "create-recipe",
      {
        TABLE_NAME: table.tableName,
        ...embeddingEnv,
      },
    );
    const getRecipeFunction = makeFunction("GetRecipeFunction", "get-recipe", {
      TABLE_NAME: table.tableName,
    });
    const updateRecipeFunction = makeFunction(
      "UpdateRecipeFunction",
      "update-recipe",
      {
        TABLE_NAME: table.tableName,
        ...embeddingEnv,
      },
    );
    const deleteRecipeFunction = makeFunction(
      "DeleteRecipeFunction",
      "delete-recipe",
      {
        TABLE_NAME: table.tableName,
      },
    );
    const searchRecipesFunction = makeFunction(
      "SearchRecipesFunction",
      "search-recipes",
      {
        TABLE_NAME: table.tableName,
        ...embeddingEnv,
        VECTOR_INDEX_NAME,
        SIMILARITY_THRESHOLD: DEFAULT_SIMILARITY_THRESHOLD,
      },
    );
    const listRecipesFunction = makeFunction(
      "ListRecipesFunction",
      "list-recipes",
      {
        TABLE_NAME: table.tableName,
        LIST_INDEX_NAME,
      },
    );

    // Explicit least-privilege statements instead of the broad grant* bundles.
    // Note the empty account field: foundation models are account-less.
    const bedrockModelArn = `arn:${this.partition}:bedrock:${this.region}::foundation-model/${embeddingModelId}`;
    const grant = (
      fn: NodejsFunction,
      actions: string[],
      resources: string[],
    ): void => {
      fn.addToRolePolicy(new PolicyStatement({ actions, resources }));
    };
    grant(createRecipeFunction, ["dynamodb:PutItem"], [table.tableArn]);
    grant(createRecipeFunction, ["bedrock:InvokeModel"], [bedrockModelArn]);
    grant(getRecipeFunction, ["dynamodb:GetItem"], [table.tableArn]);
    grant(updateRecipeFunction, ["dynamodb:PutItem"], [table.tableArn]);
    grant(updateRecipeFunction, ["bedrock:InvokeModel"], [bedrockModelArn]);
    grant(deleteRecipeFunction, ["dynamodb:DeleteItem"], [table.tableArn]);
    // SearchVectors is a new IAM action; grantReadData does not include it.
    grant(
      searchRecipesFunction,
      ["dynamodb:SearchVectors"],
      [table.tableArn, `${table.tableArn}/index/*`],
    );
    grant(searchRecipesFunction, ["bedrock:InvokeModel"], [bedrockModelArn]);
    // Query against a GSI authorizes on the index ARN, not the table ARN.
    grant(
      listRecipesFunction,
      ["dynamodb:Query"],
      [`${table.tableArn}/index/${LIST_INDEX_NAME}`],
    );

    const vectorIndex = new VectorIndex(this, "RecipeEmbeddingIndex", {
      table,
      indexName: VECTOR_INDEX_NAME,
      vectorAttributeName: VECTOR_ATTRIBUTE_NAME,
      dimensions: EMBEDDING_DIMENSIONS,
      distanceFunction: "COSINE",
      inlineFilterAttributes: [{ name: "cuisine", type: "S" }],
      projectionType: "ALL",
      logRetention,
      logRemovalPolicy: removalPolicy,
    });

    const openApiPath = fileURLToPath(
      new URL("../openapi/openapi.yaml", import.meta.url),
    );
    const definition = substitutePlaceholders(
      load(readFileSync(openApiPath, "utf8")),
      {
        "${Partition}": this.partition,
        "${Region}": this.region,
        "${CreateRecipeFunctionArn}": createRecipeFunction.functionArn,
        "${GetRecipeFunctionArn}": getRecipeFunction.functionArn,
        "${UpdateRecipeFunctionArn}": updateRecipeFunction.functionArn,
        "${DeleteRecipeFunctionArn}": deleteRecipeFunction.functionArn,
        "${SearchRecipesFunctionArn}": searchRecipesFunction.functionArn,
        "${ListRecipesFunctionArn}": listRecipesFunction.functionArn,
      },
    );

    const api = new SpecRestApi(this, "RecipeApi", {
      apiDefinition: ApiDefinition.fromInline(definition),
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit: STAGE_THROTTLE_RATE,
        throttlingBurstLimit: STAGE_THROTTLE_BURST,
      },
    });

    // SpecRestApi does not wire invoke permissions for the integrations.
    for (const fn of [
      createRecipeFunction,
      getRecipeFunction,
      updateRecipeFunction,
      deleteRecipeFunction,
      searchRecipesFunction,
      listRecipesFunction,
    ]) {
      fn.addPermission("ApiInvoke", {
        principal: new ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn: api.arnForExecuteApi("*"),
      });
    }

    const apiKey = api.addApiKey("ApiKey");
    const usagePlan = api.addUsagePlan("UsagePlan", {
      throttle: {
        rateLimit: USAGE_PLAN_THROTTLE_RATE,
        burstLimit: USAGE_PLAN_THROTTLE_BURST,
      },
      quota: { limit: USAGE_PLAN_DAILY_QUOTA, period: Period.DAY },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // A fresh stack must not serve traffic before the vector index exists.
    api.latestDeployment?.node.addDependency(vectorIndex);
    api.deploymentStage.node.addDependency(vectorIndex);

    // ---- GraphQL API: the same six operations behind AppSync ----
    // A single "lambdalith" data source serves every field; the function's
    // registry dispatches on Query/Mutation + fieldName. Its IAM role is the
    // union of the six cores' permissions: still exact actions, still scoped
    // to this table, but without the REST side's per-endpoint isolation.
    const appsyncFunction = makeFunction("AppSyncResolverFunction", "appsync", {
      TABLE_NAME: table.tableName,
      ...embeddingEnv,
      VECTOR_INDEX_NAME,
      SIMILARITY_THRESHOLD: DEFAULT_SIMILARITY_THRESHOLD,
      LIST_INDEX_NAME,
    });
    grant(
      appsyncFunction,
      ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
      [table.tableArn],
    );
    grant(
      appsyncFunction,
      ["dynamodb:Query"],
      [`${table.tableArn}/index/${LIST_INDEX_NAME}`],
    );
    grant(
      appsyncFunction,
      ["dynamodb:SearchVectors"],
      [table.tableArn, `${table.tableArn}/index/*`],
    );
    grant(appsyncFunction, ["bedrock:InvokeModel"], [bedrockModelArn]);

    const graphqlApi = new GraphqlApi(this, "RecipeGraphqlApi", {
      name: `${this.stackName}-graphql`,
      definition: Definition.fromFile(
        fileURLToPath(new URL("../graphql/schema.graphql", import.meta.url)),
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: AuthorizationType.API_KEY,
          // 365 days is the AppSync maximum; rotation after that is manual.
          apiKeyConfig: { expires: Expiration.after(Duration.days(365)) },
        },
      },
    });
    // Same rule as the REST deployment: no traffic before the index exists.
    graphqlApi.node.addDependency(vectorIndex);

    const lambdalithSource = graphqlApi.addLambdaDataSource(
      "LambdalithDataSource",
      appsyncFunction,
    );
    // One shared APPSYNC_JS handler: it forwards the context to the Lambda and
    // converts the returned envelope into typed GraphQL errors (util.error).
    // A direct resolver would flatten every thrown error to "Lambda:Unhandled".
    const resolverCode = Code.fromAsset(
      fileURLToPath(new URL("../graphql/resolver.js", import.meta.url)),
    );
    const graphqlFields: { typeName: "Query" | "Mutation"; fieldName: string }[] = [
      { typeName: "Query", fieldName: "getRecipe" },
      { typeName: "Query", fieldName: "listRecipes" },
      { typeName: "Query", fieldName: "searchRecipes" },
      { typeName: "Mutation", fieldName: "createRecipe" },
      { typeName: "Mutation", fieldName: "updateRecipe" },
      { typeName: "Mutation", fieldName: "deleteRecipe" },
    ];
    for (const { typeName, fieldName } of graphqlFields) {
      lambdalithSource.createResolver(`${typeName}${fieldName}Resolver`, {
        typeName,
        fieldName,
        runtime: FunctionRuntime.JS_1_0_0,
        code: resolverCode,
      });
    }

    this.graphqlUrl = new CfnOutput(this, "GraphqlUrl", {
      value: graphqlApi.graphqlUrl,
      description: "AppSync GraphQL endpoint",
    });
    this.graphqlApiId = new CfnOutput(this, "GraphqlApiId", {
      value: graphqlApi.apiId,
      description:
        "AppSync API id; fetch the api key with aws appsync list-api-keys --api-id",
    });

    this.apiUrl = new CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "Base URL of the deployed API stage",
    });
    this.apiKeyId = new CfnOutput(this, "ApiKeyId", {
      value: apiKey.keyId,
      description:
        "API key id; fetch the value with aws apigateway get-api-key --include-value",
    });
  }
}
