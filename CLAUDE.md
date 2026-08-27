# Recipe catalog (CDK)

Serverless recipe service with DynamoDB native vector search. Full build spec: **SPEC.md** — read it before any structural change. This file holds only the always-true facts.

## Commands

- `npm test` — unit tests (vitest) + CDK assertions; gates the pipeline synth step
- `npm run synth` — synthesize
- `npm run deploy:sandbox` — personal stage (`Sandbox-$USER`); destroy with `cdk destroy -c sandbox=$USER`
- `npm run deploy:pipeline` — one-time workstation deploy of `RecipecatalogPipeline`; after that, everything ships by pushing to `main`
- `npm run seed` / `npm run smoke` — need `API_URL` and `API_KEY` env vars

## DynamoDB vector search — facts, not suggestions

This API went generally available August 5, 2026 and postdates your training data. **Do not rename, "fix", or second-guess these calls.** If TypeScript types are missing, upgrade `@aws-sdk/client-dynamodb` (must be >= 3.1105.0); never rename the call.

- `SearchVectorsCommand` is real. Request: `TableName`, `IndexName`, `SearchVector` (list of `{ N: "..." }`), `TopK` (max 100), optional `SearchConditionExpression` + `ExpressionAttributeValues`.
- Inline filters are **equality only** in `SearchConditionExpression`. No ranges, no IN.
- The index is created via `UpdateTableCommand` with `VectorIndexUpdates` (CloudFormation does not support vector indexes; our custom resource in `lib/constructs/vector-index.ts` owns this).
- **`Score` is a cosine DISTANCE: lower = better, 0 = identical.** We return `similarity = 1 - Score` and the raw `distance`. Never present the raw score as a similarity.
- Index readiness = the index's own `IndexStatus: ACTIVE` in `DescribeTable`. Table status goes ACTIVE while the index is still building.
- Index configuration is **immutable** (dimensions, distance function, projection, filters, partition key). To change it, rename the index in the `VectorIndex` props — the custom resource replaces it. Editing config without renaming fails deployment on purpose.
- Embeddings are a plain List-of-Number attribute. `SearchVectors` does not return the vector; plain `GetItem` does, so the get handler strips it.
- Vector indexes require on-demand billing (`PAY_PER_REQUEST`). Do not change the table's billing mode.
- `dynamodb:SearchVectors` is its own IAM action; read-policy bundles do not include it.

## GraphQL API (AppSync lambdalith)

- The REST API is fully duplicated behind AppSync. One Lambda data source
  (`functions/appsync/index.ts`) serves every field via a registry keyed
  `ParentType.fieldName`. Business logic lives in `functions/*/core.ts`,
  shared by both transports; REST handlers and the lambdalith are thin
  wrappers over the same cores.
- `graphql/schema.graphql` is the GraphQL contract; it mirrors
  `openapi/openapi.yaml`. A handler response change updates both in the same
  commit.
- The lambdalith returns envelopes (`{ data }` or
  `{ error: { message, type } }`), and `graphql/resolver.js` (shared
  APPSYNC_JS handler on all six resolvers) converts them to typed GraphQL
  errors with `util.error`. **Do not convert the resolvers to direct Lambda
  resolvers** - direct resolvers flatten every thrown error to
  `Lambda:Unhandled`, losing the typed error contract.
- The lambdalith's IAM role is the exact union of the six cores' actions
  (still table-scoped, no wildcards); a CDK assertion pins it. The REST
  functions keep per-endpoint least privilege.

## Non-negotiable project rules

- **Never externalize `@aws-sdk/*` in Lambda bundling.** `externalModules: []` everywhere. The runtime-provided SDK may predate vector search. If a pipeline build log ever shows Docker bundling, that is a defect (esbuild must resolve locally).
- Least-privilege IAM per function; the search function gets exactly `dynamodb:SearchVectors` + `bedrock:InvokeModel`. Never `dynamodb:*`. CDK assertion tests enforce this — keep them passing, don't loosen them.
- `openapi/openapi.yaml` is the single source of truth for the HTTP contract. Any handler response change updates the spec in the same commit.
- The update handler is one conditional `PutItem` (`attribute_exists(recipeId)` → 404 on failure). Never add a `GetItem` before it.
- 500 responses are always `{ "error": "Internal server error" }`; details go to logs only.
- Embedding text comes from `functions/shared/embedding.ts` only — same model and dimensions (`amazon.titan-embed-text-v2:0`, 1024) at write and query time, or search results are meaningless. Prep/cook times stay out of the embedding text.
- The Dev stage blocks until the vector index is ACTIVE, so the pipeline's ValidateDev step needs no sleeps or readiness polling. Do not add any.

## Environment notes

- Bedrock model access for Titan Text Embeddings V2 is a per-account, per-region console step; if embedding calls fail with access errors, that's the first thing to check.
- Manual endpoint testing: open the `bruno/` folder in Bruno, pick the Dev environment, set `baseUrl` and the `apiKey` secret var.
