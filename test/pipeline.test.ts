import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { PipelineStack } from "../lib/pipeline-stack";

const TEST_ENV = { account: "111111111111", region: "us-east-1" };

const app = new App({
  context: {
    codestarConnectionArn:
      "arn:aws:codeconnections:us-east-1:111111111111:connection/00000000-0000-0000-0000-000000000000",
    repository: "example-org/recipe-catalog-cdk",
    // Skip asset bundling; the pipeline's own cdk synth exercises it for real.
    "aws:cdk:bundling-stacks": [],
  },
});
const stack = new PipelineStack(app, "RecipecatalogPipeline", {
  env: TEST_ENV,
});
const template = Template.fromStack(stack);

interface PipelineResource {
  Properties?: {
    Name?: string;
    Stages?: {
      Name?: string;
      Actions?: { Name?: string; ActionTypeId?: { Category?: string } }[];
    }[];
  };
}

const pipelineResource = (): PipelineResource => {
  const pipelines = template.findResources(
    "AWS::CodePipeline::Pipeline",
  ) as Record<string, PipelineResource>;
  const resource = Object.values(pipelines)[0];
  if (!resource) throw new Error("No pipeline in template");
  return resource;
};

describe("pipeline stack", () => {
  it("creates the Recipecatalog pipeline", () => {
    expect(pipelineResource().Properties?.Name).toBe("Recipecatalog");
  });

  it("orders stages Source, Build, UpdatePipeline, then Dev before Prod", () => {
    const stageNames = (pipelineResource().Properties?.Stages ?? []).map(
      (stage) => stage.Name,
    );
    expect(stageNames).toContain("Dev");
    expect(stageNames).toContain("Prod");
    expect(stageNames.indexOf("UpdatePipeline")).toBeLessThan(
      stageNames.indexOf("Dev"),
    );
    expect(stageNames.indexOf("Dev")).toBeLessThan(stageNames.indexOf("Prod"));
  });

  it("gates Prod behind the PromoteToProd manual approval", () => {
    const prodStage = (pipelineResource().Properties?.Stages ?? []).find(
      (stage) => stage.Name === "Prod",
    );
    const approval = (prodStage?.Actions ?? []).find(
      (action) => action.ActionTypeId?.Category === "Approval",
    );
    expect(approval?.Name).toBe("PromoteToProd");
  });

  it("runs ValidateDev with the pinned Schemathesis version and the smoke script", () => {
    const projects = JSON.stringify(
      template.findResources("AWS::CodeBuild::Project"),
    );
    expect(projects).toContain("schemathesis==3.39.16");
    expect(projects).toContain("scripts/smoke.ts");
    expect(projects).toContain("get-api-key");
  });

  it("grants ValidateDev apigateway:GET on api keys only", () => {
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("apigateway:GET");
    expect(policies).toContain("/apikeys/*");
  });

  it("uses no cross-account KMS keys", () => {
    template.resourceCountIs("AWS::KMS::Key", 0);
  });
});
