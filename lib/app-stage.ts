import type { CfnOutput, StageProps } from "aws-cdk-lib";
import { Stage } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { StageName } from "./recipe-catalog-stack";
import { RecipecatalogStack } from "./recipe-catalog-stack";

export interface AppStageProps extends StageProps {
  readonly stage: StageName;
}

/**
 * Wraps the application stack and re-exposes its outputs so the pipeline can
 * feed them to validation steps via envFromCfnOutputs. Stack names come out as
 * Dev-Recipecatalog, Prod-Recipecatalog, and Sandbox-<name>-Recipecatalog.
 */
export class AppStage extends Stage {
  readonly apiUrl: CfnOutput;
  readonly apiKeyId: CfnOutput;
  readonly graphqlUrl: CfnOutput;
  readonly graphqlApiId: CfnOutput;
  readonly stack: RecipecatalogStack;

  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);
    this.stack = new RecipecatalogStack(this, "Recipecatalog", {
      stage: props.stage,
    });
    this.apiUrl = this.stack.apiUrl;
    this.apiKeyId = this.stack.apiKeyId;
    this.graphqlUrl = this.stack.graphqlUrl;
    this.graphqlApiId = this.stack.graphqlApiId;
  }
}
