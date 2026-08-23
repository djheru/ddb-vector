#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { AppStage } from "../lib/app-stage";
import { PipelineStack } from "../lib/pipeline-stack";

const app = new App();

// Single source of account and region for every stack and stage; nothing else
// in the repo names a region.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new PipelineStack(app, "RecipecatalogPipeline", { env });

// Personal sandbox environments, deployed and destroyed without touching the
// pipeline: npx cdk deploy "Sandbox-<name>/*" -c sandbox=<name>
const sandbox = app.node.tryGetContext("sandbox") as string | undefined;
if (sandbox) {
  new AppStage(app, `Sandbox-${sandbox}`, { stage: "dev", env });
}
