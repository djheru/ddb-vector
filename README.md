# Recipe catalog (AWS CDK)

A serverless recipe service with semantic vector search, built on API Gateway,
Lambda, Amazon Bedrock (Titan Text Embeddings V2), and DynamoDB **vector
search**. Infrastructure is AWS CDK v2 in TypeScript; delivery is a
self-mutating CDK Pipeline. This is a rebuild of
[`andmoredev/recipe-catalog`](https://github.com/andmoredev/recipe-catalog)
with the defects from its technical review corrected.

## Two facts worth knowing up front

DynamoDB vector indexes require **on-demand capacity mode** (`PAY_PER_REQUEST`);
they are not supported on provisioned tables. CloudFormation has **no
`VectorIndexes` support yet**, so this project creates the index out-of-band via
`UpdateTable` through a CDK custom resource that also blocks the deployment
until the index is `ACTIVE`.

## Prerequisites

- **Node.js 24+** and npm.
- **CDK bootstrap** (modern style), once per account/region:
  `npx cdk bootstrap aws://<account>/<region>`
- **Bedrock model access** for **Titan Text Embeddings V2**
  (`amazon.titan-embed-text-v2:0`), enabled per account and per region via the
  Bedrock console. Bedrock coverage is narrower than DynamoDB's; deploy to a
  region with both (us-east-1 and us-west-2 qualify).
- **A CodeConnections GitHub connection** (one-time, manual): console >
  Developer Tools > Settings > Connections > create, authorize the GitHub app,
  copy the ARN into `cdk.json` under `codestarConnectionArn`. Also set
  `repository` in `cdk.json` to your `<owner>/recipe-catalog-cdk` fork.

## Delivery pipeline

Every push to `main` runs:

```
Synth (npm ci, npm test, cdk synth)  ->  Dev deploy  ->  ValidateDev  ->  manual approval  ->  Prod
```

- Unit tests and CDK assertions gate synthesis; a failing test deploys nothing.
- The `VectorIndex` custom resource keeps the Dev deployment "in progress"
  until the index is queryable, so `ValidateDev` (smoke test + Schemathesis
  contract fuzzing) starts with zero waits or polling.
- The pipeline is self-mutating: changes to `lib/pipeline-stack.ts` take effect
  on the next push, before any stage deploys.

### First deploy

```bash
npm ci
npx cdk bootstrap aws://<account>/<region>   # once
# create the GitHub connection (above), fill in cdk.json, push the repo to GitHub
npx cdk deploy RecipecatalogPipeline       # once, from a workstation
```

Every subsequent change, including changes to the pipeline itself, ships by
pushing to `main`.

## Sandbox environments

Deploy a personal environment (dev-tier settings) without touching the pipeline:

```bash
npx cdk deploy "Sandbox-<name>/*" -c sandbox=<name>    # or: npm run deploy:sandbox
npx cdk destroy "Sandbox-<name>/*" -c sandbox=<name>   # or: npm run destroy:sandbox
```

Stack names come out as `Dev-Recipecatalog`, `Prod-Recipecatalog`, and
`Sandbox-<name>-Recipecatalog`.

## Fetching the API key

Every endpoint requires an `x-api-key` header. The stack outputs the key **id**
(`ApiKeyId`), never the value. Fetch the value with:

```bash
aws apigateway get-api-key --api-key <ApiKeyId> --include-value --query value --output text
```

## Seed and smoke

```bash
API_URL=<ApiUrl output> API_KEY=<key value> npm run seed    # ~12 sample recipes
API_URL=<ApiUrl output> API_KEY=<key value> npm run smoke   # end-to-end checks
```

## Bruno collection (manual testing)

Open the Bruno desktop app > File > Open Collection > select the `bruno/`
folder. Pick the **Dev** environment, paste your deployed `baseUrl` over the
placeholder, and enter the API key value as the `apiKey` **secret var** (secret
vars are stored locally by Bruno and never committed). Run the six happy-path
requests top to bottom; `errors/` holds the negative cases. Headless run:
`npx @usebruno/cli run bruno --env Dev`.

## Search score semantics

The engine's raw `Score` for the `COSINE` distance function is a **distance**:
lower is better and `0` means identical. The API converts it for you:

- `similarity` = `1 - distance` (higher is better, what you should sort and
  threshold on; results arrive sorted by it, descending)
- `distance` = the raw engine score, for transparency

Results with `similarity` below the search function's `SIMILARITY_THRESHOLD`
(default `0.15`) are dropped. The default is calibrated to Titan Text
Embeddings V2, whose cosine similarities run compressed: paraphrase-style
matches typically score in the 0.2-0.3 band, and only queries sharing
vocabulary with the recipe text score much higher. Phrase-shaped queries
("hearty chicken dinner") work far better than single keywords ("poultry").

## Vector index immutability

A vector index's configuration (dimensions, distance function, projection,
inline filter attributes) is **immutable** after creation. Changing any of
these in `VectorIndex` props without renaming fails the deployment with an
explicit error. To force a replacement, change `indexName`: the new index is
created first and CloudFormation then deletes the old one.

## Scale note (single-tenant by design)

This demo defines no vector index partition key. High-volume multi-tenant usage
would add one: it scopes each search call to a partition and is a **scale
mechanism, not access control**.

## Costs

Every create, update, and search invokes Bedrock. Vector writes, vector
storage, and `SearchVectors` calls are metered by DynamoDB separately from
standard table usage. The pipeline itself accrues CodePipeline and CodeBuild
charges per execution.

## Repository map

| Path                                     | Purpose                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| `bin/app.ts`                             | CDK entry: pipeline stack + optional sandbox stage        |
| `lib/pipeline-stack.ts`                  | CDK Pipelines definition (Synth, Dev, ValidateDev, Prod)  |
| `lib/recipe-catalog-stack.ts`            | Table, functions, IAM, API, key/usage plan, vector index  |
| `lib/constructs/vector-index.ts`         | Custom-resource construct wrapping UpdateTable            |
| `custom-resources/vector-index-handler/` | on-event (create/update/delete) + is-complete (readiness) |
| `functions/`                             | The five handlers plus shared embedding/http/type modules |
| `openapi/openapi.yaml`                   | Single source of truth for the HTTP contract              |
| `bruno/`                                 | Manual test collection                                    |
| `scripts/`                               | `seed.ts` and `smoke.ts`                                  |
| `test/`                                  | vitest unit tests + CDK assertion tests                   |

## Scripts

| Command                                      | What it does                                         |
| -------------------------------------------- | ---------------------------------------------------- |
| `npm run build`                              | Type-check (`tsc --noEmit`)                          |
| `npm test`                                   | vitest unit + CDK assertion tests                    |
| `npm run synth`                              | `cdk synth`                                          |
| `npm run deploy:pipeline`                    | One-time workstation deploy of the pipeline          |
| `npm run deploy:sandbox` / `destroy:sandbox` | Personal sandbox up/down                             |
| `npm run seed` / `npm run smoke`             | Seed data / end-to-end checks against a deployed API |
