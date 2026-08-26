import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AppStage } from "../lib/app-stage";

const TEST_ENV = { account: "111111111111", region: "us-east-1" };

// Bundling is skipped during assertions (the pipeline runs a real cdk synth
// right after npm test, which exercises bundling for real); this keeps the
// test suite fast without weakening coverage.
const NO_BUNDLING_CONTEXT = { "aws:cdk:bundling-stacks": [] };

const synthStage = (
  stage: "dev" | "prod",
): { template: Template; stackName: string } => {
  const app = new App({ context: NO_BUNDLING_CONTEXT });
  const appStage = new AppStage(app, stage === "dev" ? "Dev" : "Prod", {
    stage,
    env: TEST_ENV,
  });
  return {
    template: Template.fromStack(appStage.stack),
    stackName: appStage.stack.stackName,
  };
};

const dev = synthStage("dev");
const prod = synthStage("prod");

interface PolicyResource {
  Properties?: {
    Roles?: { Ref?: string }[];
    PolicyDocument?: { Statement?: PolicyStatementJson[] };
  };
}

interface PolicyStatementJson {
  Action: string | string[];
  Resource: unknown;
  Effect: string;
}

interface FunctionResource {
  Properties?: {
    Runtime?: string;
    Architectures?: string[];
    Role?: { "Fn::GetAtt"?: [string, string] };
    Environment?: { Variables?: Record<string, unknown> };
  };
}

const findFunctionRoleByEnvVar = (
  template: Template,
  envKey: string,
): string => {
  const functions = template.findResources("AWS::Lambda::Function") as Record<
    string,
    FunctionResource
  >;
  const entry = Object.values(functions).find(
    (fn) =>
      fn.Properties?.Environment?.Variables &&
      envKey in fn.Properties.Environment.Variables,
  );
  const role = entry?.Properties?.Role?.["Fn::GetAtt"]?.[0];
  if (!role) throw new Error(`No function found carrying env var ${envKey}`);
  return role;
};

const statementsForRole = (
  template: Template,
  roleLogicalId: string,
): PolicyStatementJson[] => {
  const policies = template.findResources("AWS::IAM::Policy") as Record<
    string,
    PolicyResource
  >;
  return Object.values(policies)
    .filter((policy) =>
      (policy.Properties?.Roles ?? []).some(
        (role) => role.Ref === roleLogicalId,
      ),
    )
    .flatMap((policy) => policy.Properties?.PolicyDocument?.Statement ?? []);
};

const actionsOf = (statements: PolicyStatementJson[]): string[] =>
  statements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action],
  );

describe("DynamoDB table", () => {
  it("uses on-demand capacity, required for vector indexes", () => {
    dev.template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "recipeId", KeyType: "HASH" }],
    });
  });

  it("is destroyable and unprotected in dev", () => {
    dev.template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Delete",
    });
  });

  it("is retained, deletion-protected, and PITR-enabled in prod", () => {
    prod.template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: {
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
    });
  });
});

describe("search function IAM policy", () => {
  const roleId = findFunctionRoleByEnvVar(dev.template, "VECTOR_INDEX_NAME");
  const statements = statementsForRole(dev.template, roleId);
  const actions = actionsOf(statements);

  it("contains exactly dynamodb:SearchVectors for DynamoDB", () => {
    const dynamoActions = actions.filter((action) =>
      action.startsWith("dynamodb:"),
    );
    expect(dynamoActions).toEqual(["dynamodb:SearchVectors"]);
  });

  it("contains exactly bedrock:InvokeModel for Bedrock", () => {
    const bedrockActions = actions.filter((action) =>
      action.startsWith("bedrock:"),
    );
    expect(bedrockActions).toEqual(["bedrock:InvokeModel"]);
  });

  it("contains no wildcard or write/read DynamoDB grants", () => {
    expect(actions).not.toContain("dynamodb:*");
    expect(
      actions.some((action) =>
        /^dynamodb:(Put|Delete|Get|Update|Scan|Query|BatchWrite)/.test(action),
      ),
    ).toBe(false);
  });

  it("scopes SearchVectors to the table and its indexes", () => {
    const searchStatement = statements.find((statement) =>
      actionsOf([statement]).includes("dynamodb:SearchVectors"),
    );
    const resourceJson = JSON.stringify(searchStatement?.Resource);
    expect(resourceJson).toContain("/index/*");
    expect(resourceJson).toContain("Fn::GetAtt");
  });
});

describe("least privilege across all functions", () => {
  it("every dynamodb statement in the stack is scoped to the recipes table, never *", () => {
    const tableIds = Object.keys(
      dev.template.findResources("AWS::DynamoDB::Table"),
    );
    expect(tableIds).toHaveLength(1);
    const tableId = tableIds[0]!;

    const policies = dev.template.findResources("AWS::IAM::Policy") as Record<
      string,
      PolicyResource
    >;
    const dynamoStatements = Object.values(policies)
      .flatMap((policy) => policy.Properties?.PolicyDocument?.Statement ?? [])
      .filter((statement) =>
        actionsOf([statement]).some((action) => action.startsWith("dynamodb:")),
      );

    expect(dynamoStatements.length).toBeGreaterThanOrEqual(8);
    for (const statement of dynamoStatements) {
      const resourceJson = JSON.stringify(statement.Resource);
      expect(resourceJson).toContain(tableId);
      expect(resourceJson).not.toBe('"*"');
    }
  });

  it("write-path functions carry only their single table action", () => {
    for (const [envMarker, expected] of [
      ["VECTOR_INDEX_NAME", "dynamodb:SearchVectors"],
      ["LIST_INDEX_NAME", "dynamodb:Query"],
    ] as const) {
      const roleId = findFunctionRoleByEnvVar(dev.template, envMarker);
      const dynamoActions = actionsOf(
        statementsForRole(dev.template, roleId),
      ).filter((action) => action.startsWith("dynamodb:"));
      expect(dynamoActions).toEqual([expected]);
    }
  });
});

describe("log retention", () => {
  it("every log group in dev keeps logs for two weeks", () => {
    const logGroups = dev.template.findResources(
      "AWS::Logs::LogGroup",
    ) as Record<string, { Properties?: { RetentionInDays?: number } }>;
    expect(Object.keys(logGroups).length).toBeGreaterThanOrEqual(8);
    for (const [id, logGroup] of Object.entries(logGroups)) {
      expect(
        logGroup.Properties?.RetentionInDays,
        `log group ${id} has no retention`,
      ).toBe(14);
    }
  });

  it("every log group in prod keeps logs for one month", () => {
    const logGroups = prod.template.findResources(
      "AWS::Logs::LogGroup",
    ) as Record<string, { Properties?: { RetentionInDays?: number } }>;
    for (const [id, logGroup] of Object.entries(logGroups)) {
      expect(
        logGroup.Properties?.RetentionInDays,
        `log group ${id} has no retention`,
      ).toBe(30);
    }
  });
});

describe("vector index custom resource", () => {
  it("exists with the full immutable configuration in its properties", () => {
    const resources = dev.template.findResources("Custom::DynamoDBVectorIndex");
    expect(Object.keys(resources)).toHaveLength(1);
    dev.template.hasResourceProperties("Custom::DynamoDBVectorIndex", {
      IndexName: "RecipeEmbeddingIndex",
      VectorAttributeName: "embedding",
      Dimensions: 1024,
      DistanceFunction: "COSINE",
      InlineFilterAttributes: [{ name: "cuisine", type: "S" }],
      ProjectionType: "ALL",
      TableName: { Ref: Match.stringLikeRegexp("RecipesTable") },
    });
  });
});

describe("API", () => {
  const apis = dev.template.findResources("AWS::ApiGateway::RestApi") as Record<
    string,
    { Properties?: { Body?: Record<string, unknown> } }
  >;
  const api = Object.values(apis)[0];
  const body = api?.Properties?.Body;

  it("has no unresolved placeholders in the synthesized definition", () => {
    const bodyJson = JSON.stringify(body);
    for (const placeholder of [
      "${CreateRecipeFunctionArn}",
      "${GetRecipeFunctionArn}",
      "${UpdateRecipeFunctionArn}",
      "${DeleteRecipeFunctionArn}",
      "${SearchRecipesFunctionArn}",
      "${ListRecipesFunctionArn}",
      "${Region}",
      "${Partition}",
    ]) {
      expect(bodyJson).not.toContain(placeholder);
    }
  });

  it("declares the x-api-key security scheme and applies it to every operation", () => {
    const components = body?.components as
      | { securitySchemes?: Record<string, { name?: string }> }
      | undefined;
    expect(components?.securitySchemes?.ApiKeyAuth?.name).toBe("x-api-key");

    const paths = body?.paths as Record<
      string,
      Record<string, { security?: unknown[] }>
    >;
    const operations = Object.values(paths).flatMap((path) =>
      Object.entries(path)
        .filter(([method]) => ["get", "post", "put", "delete"].includes(method))
        .map(([, operation]) => operation),
    );
    expect(operations.length).toBe(6);
    for (const operation of operations) {
      expect(operation.security).toEqual([{ ApiKeyAuth: [] }]);
    }
  });

  it("throttles the deployed stage at 20 rps with burst 40", () => {
    dev.template.hasResourceProperties("AWS::ApiGateway::Stage", {
      StageName: "prod",
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          HttpMethod: "*",
          ResourcePath: "/*",
          ThrottlingRateLimit: 20,
          ThrottlingBurstLimit: 40,
        }),
      ]),
    });
  });

  it("has an API key attached to a throttled and quota-bound usage plan", () => {
    dev.template.resourceCountIs("AWS::ApiGateway::ApiKey", 1);
    dev.template.hasResourceProperties("AWS::ApiGateway::UsagePlan", {
      Throttle: { RateLimit: 10, BurstLimit: 20 },
      Quota: { Limit: 10000, Period: "DAY" },
    });
    dev.template.resourceCountIs("AWS::ApiGateway::UsagePlanKey", 1);
  });

  it("grants apigateway invoke permission on all six functions", () => {
    const permissions = dev.template.findResources(
      "AWS::Lambda::Permission",
    ) as Record<string, { Properties?: { Principal?: string } }>;
    const apiPermissions = Object.values(permissions).filter(
      (permission) =>
        permission.Properties?.Principal === "apigateway.amazonaws.com",
    );
    expect(apiPermissions).toHaveLength(6);
  });
});

describe("list GSI and list function", () => {
  it("defines the sparse name-ordered list index without projecting embeddings", () => {
    dev.template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "RecipeListIndex",
          KeySchema: [
            { AttributeName: "entityType", KeyType: "HASH" },
            { AttributeName: "name", KeyType: "RANGE" },
          ],
          Projection: Match.objectLike({
            ProjectionType: "INCLUDE",
            NonKeyAttributes: Match.arrayWith(["cuisine", "ingredients", "steps"]),
          }),
        }),
      ]),
    });
    const tables = dev.template.findResources("AWS::DynamoDB::Table");
    expect(JSON.stringify(tables)).not.toContain('"embedding"');
  });

  it("grants the list function exactly dynamodb:Query on the list index", () => {
    const roleId = findFunctionRoleByEnvVar(dev.template, "LIST_INDEX_NAME");
    const statements = statementsForRole(dev.template, roleId);
    const dynamoActions = actionsOf(statements).filter((action) =>
      action.startsWith("dynamodb:"),
    );
    expect(dynamoActions).toEqual(["dynamodb:Query"]);

    const queryStatement = statements.find((statement) =>
      actionsOf([statement]).includes("dynamodb:Query"),
    );
    expect(JSON.stringify(queryStatement?.Resource)).toContain("/index/RecipeListIndex");
  });
});

describe("lambda runtime settings", () => {
  it("runs the search function on Node 24 arm64", () => {
    dev.template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Environment: {
        Variables: Match.objectLike({
          VECTOR_INDEX_NAME: "RecipeEmbeddingIndex",
          SIMILARITY_THRESHOLD: "0.15",
        }),
      },
    });
  });
});

describe("stage naming", () => {
  it("produces the documented stack names", () => {
    expect(dev.stackName).toBe("Dev-Recipecatalog");
    expect(prod.stackName).toBe("Prod-Recipecatalog");

    const app = new App({ context: NO_BUNDLING_CONTEXT });
    const sandbox = new AppStage(app, "Sandbox-ci", {
      stage: "dev",
      env: TEST_ENV,
    });
    expect(sandbox.stack.stackName).toBe("Sandbox-ci-Recipecatalog");
  });
});

describe("stack outputs", () => {
  it("exposes the API URL and the API key id (never the value)", () => {
    dev.template.hasOutput("ApiUrl", {});
    dev.template.hasOutput("ApiKeyId", {});
  });
});
