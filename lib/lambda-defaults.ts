import { OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import type { BundlingOptions } from "aws-cdk-lib/aws-lambda-nodejs";

/**
 * Load-bearing bundling options (spec Section 5.2), shared by every function
 * in the app including the custom resource handlers:
 *
 * - externalModules: [] bundles the AWS SDK so no function ever falls back to
 *   the runtime-provided SDK, which may predate DynamoDB vector search.
 * - The createRequire banner lets CommonJS require calls inside the bundled
 *   SDK work under ESM output.
 *
 * esbuild is a devDependency so bundling is always local, never Docker.
 */
export const lambdaBundling: BundlingOptions = {
  format: OutputFormat.ESM,
  target: "node24",
  minify: true,
  externalModules: [],
  banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
};
