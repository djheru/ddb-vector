import type { StackProps } from "aws-cdk-lib";
import { Stack } from "aws-cdk-lib";
import { LinuxBuildImage } from "aws-cdk-lib/aws-codebuild";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  CodeBuildStep,
  CodePipeline,
  CodePipelineSource,
  ManualApprovalStep,
  ShellStep,
} from "aws-cdk-lib/pipelines";
import type { Construct } from "constructs";
import { AppStage } from "./app-stage";

// Schemathesis v3 CLI flags are used in ValidateDev. Schemathesis changed CLI
// flags between major versions; if this pin ever crosses a major version,
// re-check the flags against that version's documentation.
const SCHEMATHESIS_VERSION = "3.39.16";
const SCHEMATHESIS_MAX_EXAMPLES = 15;

/**
 * Self-mutating CodePipeline: push to main -> Synth (npm ci, npm test, cdk
 * synth) -> Dev deploy -> ValidateDev -> manual approval -> Prod.
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const connectionArn = this.node.tryGetContext("codestarConnectionArn") as
      | string
      | undefined;
    if (!connectionArn) {
      throw new Error(
        "Missing cdk.json context value codestarConnectionArn; create the GitHub connection once and paste its ARN (see README)",
      );
    }
    const repository =
      (this.node.tryGetContext("repository") as string | undefined) ??
      "OWNER/recipe-catalog-cdk";

    const source = CodePipelineSource.connection(repository, "main", {
      connectionArn,
    });

    // Unit tests and CDK assertions gate synthesis: a failing test means
    // nothing deploys.
    const synth = new ShellStep("Synth", {
      input: source,
      commands: ["npm ci", "npm test", "npx cdk synth"],
    });

    const pipeline = new CodePipeline(this, "Pipeline", {
      pipelineName: "Recipecatalog",
      synth,
      // Single account, single region; avoids the KMS key cost.
      crossAccountKeys: false,
      codeBuildDefaults: {
        // The library default image (standard:7.0) tops out at Node 18; the
        // AL2023 image ships the modern Node this repo's tooling needs.
        buildEnvironment: { buildImage: LinuxBuildImage.AMAZON_LINUX_2023_5 },
      },
    });

    const env = { account: this.account, region: this.region };
    const dev = new AppStage(this, "Dev", { stage: "dev", env });

    const validateDev = new CodeBuildStep("ValidateDev", {
      input: source,
      envFromCfnOutputs: { API_URL: dev.apiUrl, API_KEY_ID: dev.apiKeyId },
      commands: [
        // The VectorIndex custom resource blocks the Dev deployment until the
        // vector index is ACTIVE, so this step needs no waits, sleeps, or
        // readiness polling. Do not add any.
        'export API_KEY=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value --query value --output text)',
        "npm ci",
        "npx tsx scripts/smoke.ts",
        `python3 -m pip install --user "schemathesis==${SCHEMATHESIS_VERSION}" || python3 -m pip install --user --break-system-packages "schemathesis==${SCHEMATHESIS_VERSION}"`,
        'export PATH="$HOME/.local/bin:$PATH"',
        `schemathesis run --checks all --base-url "$API_URL" -H "x-api-key: $API_KEY" --hypothesis-max-examples ${SCHEMATHESIS_MAX_EXAMPLES} openapi/openapi.yaml`,
      ],
      rolePolicyStatements: [
        new PolicyStatement({
          actions: ["apigateway:GET"],
          resources: [
            `arn:${this.partition}:apigateway:${this.region}::/apikeys/*`,
          ],
        }),
      ],
    });

    pipeline.addStage(dev, { post: [validateDev] });
    pipeline.addStage(new AppStage(this, "Prod", { stage: "prod", env }), {
      pre: [new ManualApprovalStep("PromoteToProd")],
    });
  }
}
