# Recipe catalog on AWS CDK — Implementation Spec

## 1. Purpose

Recreate the `andmoredev/recipe-catalog` application (a serverless recipe service with semantic vector search) using **AWS CDK v2 in TypeScript** instead of AWS SAM. The rebuild is not a straight port: it must also correct a set of defects identified in a technical review of the reference implementation. Those corrections are listed in Section 3 and are **requirements, not suggestions**.

Delivery is via **CDK Pipelines** (CodePipeline-backed, self-mutating) — there are no GitHub Actions workflows in this project. Manual endpoint testing is via a **Bruno collection** committed to the repo (Section 10).

Reference implementation (for domain model and endpoint shapes only — do not copy its infrastructure or its bugs): https://github.com/andmoredev/recipe-catalog

## 2. Ground truth — read this before writing any code

DynamoDB vector search went **generally available on August 5, 2026**. It is newer than your training data. The following facts are verified against the current AWS documentation and working implementations. **Do not second-guess, rename, or "correct" these API names.** If TypeScript types for them are missing, the fix is to upgrade `@aws-sdk/client-dynamodb`, never to rename the call.

1. **The feature is real and generally available** in all commercial AWS regions and GovCloud. It is a new index type on ordinary DynamoDB tables.
2. **CloudFormation does not support vector indexes yet.** There is no `VectorIndexes` property on `AWS::DynamoDB::Table`. The index must be created out-of-band via the `UpdateTable` API. In this project that happens through a CDK custom resource (Section 6), not a post-deploy script.
3. **SDK floor:** vector search support landed in the AWS SDKs via the service model update of **August 4, 2026**. For JavaScript, `@aws-sdk/client-dynamodb` `^3.1105.0` or later is known to include `SearchVectorsCommand` and the `VectorIndexUpdates` parameter on `UpdateTableCommand`. Pin at least that version. **Every Lambda bundle must include the SDK** — never externalize `@aws-sdk/*` to the runtime-provided SDK, because the runtime copy may predate the feature.
4. **Vectors are stored using the existing List type**: an attribute whose value is `{ L: [{ N: "0.123" }, { N: "-0.456" }, ...] }`. No new data type.
5. **Creating the index** uses `UpdateTableCommand` with this exact shape (verified working):

   ```ts
   {
     TableName,
     AttributeDefinitions: [{ AttributeName: "cuisine", AttributeType: "S" }],
     VectorIndexUpdates: [{
       Create: {
         IndexName: "RecipeEmbeddingIndex",
         VectorAttribute: { AttributeName: "embedding" },
         SearchSchema: [
           { AttributeName: "cuisine", SearchSchemaElementType: "INLINE_FILTER" }
         ],
         Projection: { ProjectionType: "ALL" },
         Dimensions: 1024,
         DistanceFunction: "COSINE"
       }
     }]
   }
   ```

6. **Index readiness:** the table's `TableStatus` returns to `ACTIVE` while the vector index is still building. The correct readiness signal is `DescribeTable` → the entry for this index under the table's vector index list reporting `IndexStatus: "ACTIVE"` (and not backfilling). Poll that, not table status.
7. **Index configuration is immutable** after creation: dimensions, distance function, projection, inline filter attributes, and partition key cannot be changed. Changing any of them means delete-and-recreate under a new configuration.
8. **Searching** uses `SearchVectorsCommand` with this shape (verified working):

   ```ts
   {
     TableName,
     IndexName: "RecipeEmbeddingIndex",
     SearchVector: queryVector.map(v => ({ N: String(v) })),  // AttributeValue list
     TopK: 5,                                                  // max 100
     // optional inline filter — equality only:
     SearchConditionExpression: "cuisine = :cuisine",
     ExpressionAttributeValues: { ":cuisine": { S: "italian" } }
   }
   ```

   The response contains `SearchResults`, each with `Item` (marshalled attributes) and `Score`. Inline filters support **only the equality operator** in `SearchConditionExpression`; ranges, `IN`, and inequality are not available.

9. **Score semantics — critical:** for the `COSINE` distance function, `Score` is a **distance**: lower is better, `0` means identical vectors. It is not a similarity. (Only the dot-product distance function has higher-is-better scores.) All response shaping in Section 8 depends on getting this right.
10. **`SearchVectors` does not return the vector attribute by default**, even with `Projection: ALL`. No code is needed to strip embeddings from search results. (The plain `GetItem` path still returns it, so the get handler must strip it.)
11. **`dynamodb:SearchVectors` is a new IAM action.** Existing read-oriented policies and the CDK `grantReadData` bundle do not include it. It must be granted explicitly.
12. **Vector indexes require on-demand capacity mode** (`PAY_PER_REQUEST`). They are not supported on provisioned-capacity tables.
13. **Bedrock model access** for `amazon.titan-embed-text-v2:0` must be enabled per account and per region before anything works, and Bedrock model availability is narrower than DynamoDB region coverage. Deploy to a region that has both (us-east-1 and us-west-2 both qualify).

## 3. Corrections carried over from the review (mandatory)

1. Bundle the AWS SDK into every Lambda (`externalModules: []`); never rely on the runtime-provided SDK.
2. Search function IAM: exactly `dynamodb:SearchVectors` plus `bedrock:InvokeModel`. No `dynamodb:*`, no unused write grants.
3. Score handling: convert distance to cosine similarity (`1 − Score`), name the response field `similarity`, also return the raw `distance`, and make the OpenAPI contract match the code exactly.
4. Update handler: single conditional `PutItem` with `ConditionExpression: "attribute_exists(recipeId)"` mapped to 404 on failure. No read-then-write.
5. Actually use the inline filter the index defines: search accepts an optional `cuisine` parameter.
6. Bound the search query (`maxLength` in the contract) and clamp `topK` server-side.
7. Sanitized error responses: never return `error.message` from a 500; log details server-side, return a generic message.
8. Shared embedding module instead of three copies.
9. Region and naming flow from one place; no duplicated hardcoded config across files.
10. The deployment must not report success until the vector index is `ACTIVE` (the custom resource guarantees this structurally).
11. The endpoint must not be anonymous: API key + usage plan with throttling.
12. Log retention set explicitly on every function (no infinite-retention default).

## 4. Repository layout

```
recipe-catalog-cdk/
├── bin/
│   └── app.ts                        # CDK app entry: pipeline + optional sandbox stage
├── lib/
│   ├── pipeline-stack.ts             # CDK Pipelines definition (Section 12)
│   ├── app-stage.ts                  # Stage wrapping the app stack; exposes outputs
│   ├── recipe-catalog-stack.ts     # the application stack
│   └── constructs/
│       └── vector-index.ts           # VectorIndex construct (custom resource)
├── custom-resources/
│   └── vector-index-handler/
│       ├── on-event.ts               # create / update / delete
│       └── is-complete.ts            # readiness polling
├── functions/
│   ├── shared/
│   │   ├── embedding.ts              # buildEmbeddingText + generateEmbedding
│   │   ├── http.ts                   # response helpers, error sanitization
│   │   └── types.ts                  # RecipeInput, Ingredient, marshall helpers
│   ├── create-recipe/index.ts
│   ├── get-recipe/index.ts
│   ├── update-recipe/index.ts
│   ├── delete-recipe/index.ts
│   └── search-recipes/index.ts
├── openapi/
│   └── openapi.yaml                  # single source of truth for the contract
├── bruno/                            # manual test collection (Section 10)
│   ├── bruno.json
│   ├── collection.bru
│   ├── environments/
│   │   ├── Dev.bru
│   │   └── Prod.bru
│   ├── Create Recipe.bru
│   ├── Get Recipe.bru
│   ├── Update Recipe.bru
│   ├── Search Recipes.bru
│   ├── Search With Cuisine Filter.bru
│   ├── Delete Recipe.bru
│   └── errors/
│       ├── Create Invalid Recipe.bru
│       ├── Get Missing Recipe.bru
│       ├── Update Missing Recipe.bru
│       ├── Search Query Too Long.bru
│       └── Wrong Api Key.bru
├── scripts/
│   ├── seed.ts                       # loads ~12 sample recipes via the API
│   └── smoke.ts                      # end-to-end sanity checks
├── test/
│   ├── stack.test.ts                 # CDK assertions
│   └── handlers/*.test.ts            # vitest unit tests
├── cdk.json
├── package.json
├── tsconfig.json
└── README.md
```

## 5. CDK app and stacks

- `aws-cdk-lib` v2 (latest), `constructs` v10, TypeScript strict mode, ESM.
- `bin/app.ts` always instantiates `PipelineStack` (stack name `RecipecatalogPipeline`). When the context value `sandbox` is present (`-c sandbox=<name>`), it additionally instantiates `AppStage` directly as `Sandbox-<name>` with dev-tier settings, so developers can deploy and destroy a personal environment without touching the pipeline: `npx cdk deploy "Sandbox-<name>/*" -c sandbox=<name>`.
- `AppStage` (a `Stage` subclass) takes `{ stage: "dev" | "prod" }` as a **prop** (not context), instantiates `RecipecatalogStack`, and re-exposes the stack's `CfnOutput`s as `readonly apiUrl: CfnOutput` and `readonly apiKeyId: CfnOutput` so the pipeline can feed them to validation steps. Deployed stack names come out as `Dev-Recipecatalog`, `Prod-Recipecatalog`, `Sandbox-<name>-Recipecatalog`.
- Account and region come from `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` in `bin/app.ts` and are passed explicitly to every stage. Nothing else in the repo names a region. Single account, single region.
- Stage-dependent protective settings:

| Setting                     | dev / sandbox | prod        |
| --------------------------- | ------------- | ----------- |
| Table `removalPolicy`       | `DESTROY`     | `RETAIN`    |
| Table `deletionProtection`  | false         | true        |
| Table `pointInTimeRecovery` | false         | true        |
| Log retention               | `TWO_WEEKS`   | `ONE_MONTH` |

### 5.1 DynamoDB table

- Construct: `dynamodb.Table` (the classic `AWS::DynamoDB::Table` resource — **not** `TableV2`, which synthesizes `AWS::DynamoDB::GlobalTable` and has unverified interaction with out-of-band `UpdateTable` calls).
- Partition key: `recipeId` (string). No sort key. `billingMode: PAY_PER_REQUEST` (required — see ground truth 12).

### 5.2 Lambda functions (all five)

- `NodejsFunction` from `aws-cdk-lib/aws-lambda-nodejs`.
- Runtime `Runtime.NODEJS_24_X` (if the installed `aws-cdk-lib` predates that enum member, upgrade `aws-cdk-lib`; do not fall back to an older runtime), architecture `ARM_64`, memory 256 MB, timeout 15 seconds.
- Bundling options — these are load-bearing:

  ```ts
  bundling: {
    format: OutputFormat.ESM,
    target: "node24",
    minify: true,
    externalModules: [],   // bundle the SDK — see ground truth 3
    banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
  }
  ```

- `esbuild` must be a devDependency so `NodejsFunction` uses local bundling everywhere, including inside CodeBuild — Docker-fallback bundling would require privileged mode in the pipeline and must never be triggered.
- Environment variables (only what each function needs): `TABLE_NAME`, `EMBEDDING_MODEL_ID` (default `amazon.titan-embed-text-v2:0`, a stack prop), `VECTOR_INDEX_NAME` (`RecipeEmbeddingIndex`), `SIMILARITY_THRESHOLD` (search only, default `"0.15"`; calibrated to Titan Text Embeddings V2, whose cross-vocabulary paraphrase matches measure only ~0.21-0.26 cosine similarity).
- `logGroup` per function with the stage-appropriate retention from the table in Section 5.

### 5.3 IAM — exact grants, nothing broader

Prefer explicit `PolicyStatement`s over the broad `grant*` bundles so the policy is exactly this:

| Function                     | DynamoDB actions (resource)                                        | Bedrock               |
| ---------------------------- | ------------------------------------------------------------------ | --------------------- |
| create-recipe                | `dynamodb:PutItem` (table ARN)                                     | `bedrock:InvokeModel` |
| get-recipe                   | `dynamodb:GetItem` (table ARN)                                     | —                     |
| update-recipe                | `dynamodb:PutItem` (table ARN)                                     | `bedrock:InvokeModel` |
| delete-recipe                | `dynamodb:DeleteItem` (table ARN)                                  | —                     |
| search-recipes               | `dynamodb:SearchVectors` (table ARN **and** `${tableArn}/index/*`) | `bedrock:InvokeModel` |
| vector-index custom resource | `dynamodb:UpdateTable`, `dynamodb:DescribeTable` (table ARN)       | —                     |

Bedrock resource ARN (note the empty account field — foundation models are account-less):
`arn:${partition}:bedrock:${region}::foundation-model/${modelId}`

A CDK assertions test must lock this in (Section 11).

## 6. The `VectorIndex` construct (custom resource)

This is the piece that replaces the reference project's post-deploy script, and it must be a first-class part of the stack so that a deployment does not complete until the index is queryable.

- Implement with the **custom resource Provider framework** (`custom_resources.Provider`) using two `NodejsFunction` handlers, both bundled with `@aws-sdk/client-dynamodb` pinned `>= 3.1105.0` (same bundling rules as Section 5.2 — the whole point is controlling the SDK version).
- Provider settings: `queryInterval: Duration.seconds(15)`, `totalTimeout: Duration.minutes(30)` (backfill on a pre-populated table can take a while; on a fresh table it is fast).
- Construct props: `table: ITable`, `indexName`, `vectorAttributeName`, `dimensions`, `distanceFunction`, `inlineFilterAttributes: { name: string; type: "S" | "N" }[]`, `projectionType`.
- The custom resource's properties must include every config value so CloudFormation detects changes.
- **PhysicalResourceId = the index name.** This gives correct replacement semantics for free.

### 6.1 `on-event.ts` behavior

- **Create:** call `UpdateTable` with the exact shape from ground truth 5, built from the props. If the call fails because the index already exists with the same name (retry after partial failure), treat as success. Return `{ PhysicalResourceId: indexName }`.
- **Update:** if `indexName` is unchanged but any other property changed, **throw** with the message: `"Vector index configuration is immutable (dimensions, distance function, projection, filters). Change indexName to force replacement."` If `indexName` changed, run Create for the new name; CloudFormation will subsequently send Delete for the old physical id, which removes the old index. If nothing material changed, no-op.
- **Delete:** call `UpdateTable` with `VectorIndexUpdates: [{ Delete: { IndexName } }]`. Swallow `ResourceNotFoundException` and any table-not-found error so stack teardown never wedges.

### 6.2 `is-complete.ts` behavior

- **Create/Update:** `DescribeTable`; complete when the index appears in the table's vector index list with `IndexStatus === "ACTIVE"` and no backfill in progress. The SDK's `TableDescription` type may lag the wire format — read the vector index list defensively (cast if needed) but do not guess field names beyond `IndexName` / `IndexStatus`; log the raw describe output on the first poll so mismatches are diagnosable.
- **Delete:** complete when the index is absent from the description or the table itself is gone.

### 6.3 Wiring

`new VectorIndex(this, "RecipeEmbeddingIndex", { table, indexName: "RecipeEmbeddingIndex", vectorAttributeName: "embedding", dimensions: 1024, distanceFunction: "COSINE", inlineFilterAttributes: [{ name: "cuisine", type: "S" }], projectionType: "ALL" })`. The search function's event source (the API) does not need an explicit `dependsOn`, but add `node.addDependency` from the API deployment to the `VectorIndex` construct anyway so a fresh stack cannot serve traffic before the index exists.

## 7. HTTP interface

### 7.1 Contract-first with `SpecRestApi`

- `openapi/openapi.yaml` remains the single source of truth. Start from the reference project's spec (it is good: gateway request validators, bounded strings, patterns, response links) and apply the changes in 7.2.
- In the stack, load the YAML at synth time (`js-yaml`), walk the object, and replace the string placeholders `${CreateRecipeFunctionArn}` etc. inside the `x-amazon-apigateway-integration.uri` values with the real function ARNs (CDK token concatenation inside the URI string is fine). Feed the result to `apigateway.SpecRestApi` with `ApiDefinition.fromInline(...)`.
- `deployOptions`: stage name `prod`, `throttlingRateLimit: 20`, `throttlingBurstLimit: 40`.
- For each function, add an invoke permission for `apigateway.amazonaws.com` scoped with `sourceArn: api.arnForExecuteApi("*")` — `SpecRestApi` does not do this for you.

### 7.2 Contract changes relative to the reference spec

1. `SearchInput`: `query` gets `maxLength: 1000` (keep `minLength: 1`); add optional `cuisine` (same pattern and bounds as the recipe field) and optional `topK` (integer, 1–25).
2. `SearchResult`: replace `score` with two fields — `similarity` (number, −1..1, higher is better) and `distance` (number, ≥0, raw engine score). Mark both plus `recipeId` and `name` as `required` and set `additionalProperties: false` so the contract tests can actually catch drift.
3. Add `additionalProperties: false` to `RecipeInput`, `Ingredient`, and `SearchInput`.
4. Security: `components.securitySchemes.ApiKeyAuth: { type: apiKey, in: header, name: x-api-key }` and `security: [{ ApiKeyAuth: [] }]` on every operation.
5. Keep the reference spec's request validators, gateway responses, examples, and operation links as-is.

### 7.3 API key and usage plan

- `api.addApiKey(...)` + `api.addUsagePlan(...)` with `throttle: { rateLimit: 10, burstLimit: 20 }` and a quota of 10,000 requests/day; attach the key and the deployed stage to the plan.
- Output the API key **id** (not value) as a stack output; the README documents retrieving the value with `aws apigateway get-api-key --api-key <id> --include-value`.

## 8. Lambda handler specifications

All handlers: parse defensively, validate even though the gateway also validates (defense in depth), log a structured JSON line per request (`level`, `msg`, `recipeId`/`query` where relevant, `error` details on failure), and return errors through a shared helper so 4xx bodies are `{ "error": "<specific reason>" }` and every 500 body is exactly `{ "error": "Internal server error" }` with details only in the log.

### 8.1 `shared/embedding.ts`

- `buildEmbeddingText(recipe)`: concatenate name, description, `Cuisine: <cuisine>.`, `Dietary: <tags>.` (when present), `Ingredients: <names>.` — same as the reference **minus the prep/cook time sentence** (numeric times add noise to the vector; times remain stored attributes).
- `generateEmbedding(text)`: Bedrock `InvokeModelCommand` on `EMBEDDING_MODEL_ID` with body `{ inputText, dimensions: 1024, normalize: true }`; parse `embedding` from the response. Throw a typed error on Bedrock validation failures so callers can map to 400.

### 8.2 create-recipe — `POST /recipes`

Validate required fields and numeric ranges (integers; prep/cook 0–10080; servings 1–1000). `recipeId = randomUUID()`. Build embedding text, generate embedding, single `PutItem` with `ConditionExpression: "attribute_not_exists(recipeId)"` (paranoia against UUID collision costs nothing). Item shape matches the reference: strings, numbers, `dietary` as a string list, `ingredients` as a list of maps, `steps` as a string list, `embedding` as `{ L: [{ N }, ...] }`. Return 201 `{ recipeId, message: "Recipe created" }`.

### 8.3 get-recipe — `GET /recipes/{recipeId}`

`GetItem`, 404 when absent, `unmarshall`, **delete the `embedding` field**, return 200.

### 8.4 update-recipe — `PUT /recipes/{recipeId}`

Same validation as create. Regenerate the embedding, then a **single** `PutItem` with `ConditionExpression: "attribute_exists(recipeId)"`. Map `ConditionalCheckFailedException` → 404. No `GetItem`. Return 200 `{ recipeId, message: "Recipe updated" }`.

### 8.5 delete-recipe — `DELETE /recipes/{recipeId}`

As the reference: conditional `DeleteItem` on `attribute_exists(recipeId)`, `ConditionalCheckFailedException` → 404.

### 8.6 search-recipes — `POST /recipes/search`

1. Validate `query` (string, 1–1000 chars). Clamp `topK` to 1–25, default 5. Validate optional `cuisine` against the same pattern as the recipe field.
2. Embed the query with the shared module (identical model + dimensions as write time — this invariant is what makes the search meaningful).
3. `SearchVectorsCommand` per ground truth 8; include `SearchConditionExpression`/`ExpressionAttributeValues` only when `cuisine` was provided.
4. For each result: `distance = Score`, `similarity = 1 − Score` (round to 4 decimal places). Drop results with `similarity < SIMILARITY_THRESHOLD`. Map item attributes to the response shape (recipeId, name, cuisine, description, dietary, prepTimeMinutes, cookTimeMinutes, servings, similarity, distance).
5. Return 200 `{ query, cuisine?, results }`. An empty `results` array is a valid, expected outcome.
6. Map Bedrock input-validation errors to 400; everything else unexpected to the sanitized 500.

## 9. Seed and smoke scripts

- `scripts/seed.ts`: posts ~12 recipes spanning at least four cuisines and varied dietary tags through the deployed API (reads `API_URL` and `API_KEY` from env). Idempotence is not required; it is a demo seeder.
- `scripts/smoke.ts`: (1) create a distinctive recipe, (2) get it and assert the embedding is absent, (3) search with a paraphrase of it (no shared keywords) and assert it appears with `similarity` above threshold and that results are sorted by `similarity` descending, (4) search with the `cuisine` filter and assert only that cuisine returns, (5) update it and assert 200, (6) update a random id and assert 404, (7) delete it. Exit non-zero on any failure.

## 10. Bruno collection (manual testing)

A complete Bruno collection lives in `bruno/` so the endpoints can be exercised by hand from the Bruno desktop app (File → Open Collection → select the `bruno/` folder). It is plain text and reviewed like any other code.

### 10.1 Collection plumbing

- `bruno/bruno.json`: `{ "version": "1", "name": "recipe-catalog", "type": "collection" }`.
- `bruno/collection.bru` sets the API key header once for every request:

  ```
  headers {
    x-api-key: {{apiKey}}
  }
  ```

- `bruno/environments/Dev.bru` and `Prod.bru`:

  ```
  vars {
    baseUrl: https://REPLACE-ME.execute-api.REGION.amazonaws.com/prod
  }
  vars:secret [
    apiKey
  ]
  ```

  `baseUrl` is committed with a placeholder the user pastes over after deploying. `apiKey` is declared as a **secret var** so its value is entered in the Bruno UI and stored locally, never committed. The README explains both.

### 10.2 Happy-path requests (sequenced — the collection runner executes them in order as a manual smoke suite)

Every request carries `meta.seq` for ordering and `assert` blocks for status codes. `Create Recipe.bru` is the canonical example of the exact file format; produce the others in the same shape:

```
meta {
  name: Create Recipe
  type: http
  seq: 1
}

post {
  url: {{baseUrl}}/recipes
  body: json
  auth: none
}

body:json {
  {
    "name": "Spicy Chicken Stew",
    "cuisine": "mexican",
    "dietary": ["gluten-free"],
    "prepTimeMinutes": 15,
    "cookTimeMinutes": 45,
    "servings": 4,
    "description": "A fiery, slow-simmered chicken stew with chipotle and tomatoes.",
    "ingredients": [
      { "name": "chicken thighs", "amount": "600", "unit": "g" },
      { "name": "chipotle peppers", "amount": "2", "unit": "pieces" }
    ],
    "steps": ["Brown the chicken", "Simmer with chipotle and tomatoes for 45 minutes"]
  }
}

assert {
  res.status: eq 201
  res.body.recipeId: isDefined
}

script:post-response {
  bru.setVar("recipeId", res.body.recipeId);
}
```

1. **Create Recipe** (seq 1) — as above; captures `recipeId` into a runtime var for the rest of the run.
2. **Get Recipe** (seq 2) — `GET {{baseUrl}}/recipes/{{recipeId}}`; assert `res.status: eq 200` and `res.body.embedding: isUndefined`.
3. **Update Recipe** (seq 3) — `PUT` with a modified description and an extra ingredient; assert 200.
4. **Search Recipes** (seq 4) — `POST {{baseUrl}}/recipes/search` with `{ "query": "hot and hearty poultry dish" }` (deliberately no keyword overlap with the created recipe); assert 200, plus a `tests` block using chai to assert `res.body.results` is an array and is sorted by `similarity` descending.
5. **Search With Cuisine Filter** (seq 5) — body `{ "query": "something spicy", "cuisine": "mexican", "topK": 3 }`; assert 200 and a `tests` block asserting every result's `cuisine` equals `mexican`.
6. **Delete Recipe** (seq 6) — `DELETE {{baseUrl}}/recipes/{{recipeId}}`; assert 200.

### 10.3 `errors/` folder — negative cases

1. **Create Invalid Recipe** — body missing `name` and `ingredients`; assert `res.status: eq 400` (gateway request validation, not the Lambda).
2. **Get Missing Recipe** — hardcoded random UUID; assert 404.
3. **Update Missing Recipe** — hardcoded random UUID with a valid body; assert 404 (exercises the conditional write).
4. **Search Query Too Long** — a `script:pre-request` block runs `bru.setVar("longQuery", "x".repeat(2000));` and the body is `{ "query": "{{longQuery}}" }`; assert 400 (rejected at the gateway by `maxLength`, never reaches Bedrock).
5. **Wrong Api Key** — request-level `headers { x-api-key: not-a-real-key }` overriding the collection header; assert 403.

The collection is also runnable headlessly with `npx @usebruno/cli run bruno --env Dev` — do not add it to the pipeline (Schemathesis and `smoke.ts` cover automation); it exists for manual use.

## 11. Tests

- **Unit (vitest + `aws-sdk-client-mock`):** score conversion math (distance 0.15 → similarity 0.85), threshold filtering, topK clamping, `ConditionalCheckFailedException` → 404 in update and delete, 500 bodies never contain internal messages, `buildEmbeddingText` output has no prep/cook sentence, search sends `SearchConditionExpression` only when cuisine present.
- **CDK assertions (`aws-cdk-lib/assertions`):** table is `PAY_PER_REQUEST`; the search function's policy contains `dynamodb:SearchVectors` and does **not** contain `dynamodb:*` or any `dynamodb:Put*`/`Delete*`; every function's policy is limited to its table ARN; log retention is set on all log groups; the custom resource exists and its properties carry dimensions/distance/index name. Run these against a synthesized `AppStage`, not the pipeline stack.
- Do not attempt to unit test the live vector index; that is what `smoke.ts` is for.

## 12. Delivery pipeline (CDK Pipelines — no GitHub Actions)

Continuous delivery uses the **CDK Pipelines** library (`aws-cdk-lib/pipelines`): a self-mutating CodePipeline that deploys Dev, validates it, and promotes to Prod behind a manual approval. There is no `.github/workflows/` directory in this repository.

### 12.1 `PipelineStack`

- Source: `CodePipelineSource.connection("<owner>/recipe-catalog-cdk", "main", { connectionArn })`. The CodeStar Connections GitHub connection is a **one-time manual setup** (console: Developer Tools → Settings → Connections → create, authorize the GitHub app, copy the ARN); its ARN is supplied via cdk.json context key `codestarConnectionArn`. The pipeline triggers on every push to `main` — no path filtering.
- Synth step: `ShellStep("Synth", { input: source, commands: ["npm ci", "npm test", "npx cdk synth"] })`. Unit tests and CDK assertions gate synthesis — a failing test means nothing deploys.
- Pipeline: `new pipelines.CodePipeline(this, "Pipeline", { pipelineName: "Recipecatalog", synth, crossAccountKeys: false })`. Self-mutation stays at its default (enabled): pipeline definition changes take effect on the next push without redeploying from a workstation. `crossAccountKeys: false` because this is single-account (avoids the KMS key cost; flip it on if a second account ever enters the picture).
- No Docker anywhere in the pipeline: `NodejsFunction` bundling must resolve local `esbuild` (Section 5.2). If a build log ever shows Docker bundling, that is a defect.

### 12.2 Stages

1. **Dev:** `pipeline.addStage(new AppStage(this, "Dev", { stage: "dev", env }), { post: [validateDev] })`.
2. **Prod:** `pipeline.addStage(new AppStage(this, "Prod", { stage: "prod", env }), { pre: [new ManualApprovalStep("PromoteToProd")] })`.

### 12.3 The `ValidateDev` step

A `CodeBuildStep` (not a plain `ShellStep` — it needs an IAM statement), wired with `envFromCfnOutputs: { API_URL: dev.apiUrl, API_KEY_ID: dev.apiKeyId }`:

1. `API_KEY=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value --query value --output text)` — requires `rolePolicyStatements` granting `apigateway:GET` on `arn:${partition}:apigateway:${region}::/apikeys/*`.
2. `npm ci && npx tsx scripts/smoke.ts` (smoke reads `API_URL` and `API_KEY` from env).
3. Install a **pinned** Schemathesis version with pip and run it against `$API_URL` using `openapi/openapi.yaml`, passing the header `x-api-key: $API_KEY`. Schemathesis changed CLI flags between major versions — match the flags to the pinned version's documentation rather than assuming.

Because the `VectorIndex` custom resource blocks the Dev deployment until the index is `ACTIVE`, this step needs **no waits, sleeps, or readiness polling** — add a comment in the step saying exactly that so nobody reintroduces one.

### 12.4 Environments summary

| Environment    | Created by                                | Purpose                                       | Teardown                                 |
| -------------- | ----------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| Sandbox-<name> | developer, `cdk deploy -c sandbox=<name>` | pre-merge experimentation                     | `cdk destroy -c sandbox=<name>`          |
| Dev            | pipeline, automatic                       | integration target for smoke + contract tests | delete stack manually if ever needed     |
| Prod           | pipeline, after manual approval           | the real thing                                | protected (RETAIN + deletion protection) |

Per-pull-request ephemeral environments are intentionally out: CodePipeline is branch-triggered, and sandbox stages cover pre-merge testing.

### 12.5 Bootstrap and first deploy

Document in the README: `npx cdk bootstrap aws://<account>/<region>` (modern bootstrap) once, create the GitHub connection once, then a single workstation `npx cdk deploy RecipecatalogPipeline`. Every subsequent change — including changes to the pipeline itself — ships by pushing to `main`.

## 13. package.json and tooling

- `type: module`, `engines.node >= 24`.
- Dependencies: `@aws-sdk/client-dynamodb` (>= 3.1105.0), `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/util-dynamodb`. Dev: `aws-cdk-lib`, `constructs`, `aws-cdk`, `esbuild`, `typescript`, `vitest`, `aws-sdk-client-mock`, `@types/aws-lambda`, `js-yaml` + types, `tsx`.
- Scripts: `build` (tsc noEmit), `test`, `synth`, `deploy:pipeline` (`cdk deploy RecipecatalogPipeline`), `deploy:sandbox` (`cdk deploy --all -c sandbox=$USER`), `seed`, `smoke`.
- Nothing in this file may reference any other project. (The reference repo shipped a package.json from a different codebase; do not repeat that.)

## 14. README requirements

Cover: prerequisites (Node 24, CDK bootstrap, Bedrock model access enabled for Titan Text Embeddings V2 in the target region, the one-time CodeStar GitHub connection); the on-demand-capacity and CloudFormation-gap facts from Section 2 in two sentences; the pipeline model (push to `main` → tests → Dev → validation → manual approval → Prod) and the first-deploy steps from 12.5; sandbox stage usage; how to fetch the API key; Bruno setup (open the `bruno/` folder, pick the Dev environment, paste `baseUrl`, enter `apiKey` as the secret var, run the collection top to bottom); the score semantics (`similarity` = 1 − cosine distance, higher is better); the immutability rule for the index and how to force replacement (rename); and a cost note: every create/update/search invokes Bedrock; vector writes, storage, and searches are metered by DynamoDB separately from standard table usage; and the pipeline itself accrues CodePipeline/CodeBuild charges.

## 15. Non-goals

No frontend, no CORS, no vector index partition key (single-tenant demo scale; document in the README that high-volume multi-tenant usage would add one — noting it scopes each search call and is a scale mechanism, not access control), no DynamoDB Streams / async embedding path, no custom domain, no multi-region, no multi-account pipeline, no per-pull-request ephemeral environments (see 12.4).

## 16. Acceptance criteria

1. `npm test` passes: all unit tests and all CDK assertion tests, including the least-privilege assertions in Section 11.
2. `npx cdk synth` succeeds for the pipeline and (with `-c sandbox=ci`) for a sandbox stage, with zero placeholder strings left in the synthesized API definition.
3. After the one-time bootstrap, connection setup, and `cdk deploy RecipecatalogPipeline`, a push to `main` runs Synth → Dev deploy → ValidateDev → manual approval gate → Prod, with no failures up to the gate.
4. The Dev deployment does not report success until the vector index is `ACTIVE`, and `ValidateDev` passes immediately with no retries, sleeps, or readiness polling.
5. A commit that only edits `lib/pipeline-stack.ts` self-mutates the pipeline on the next push before any stage deploys.
6. No pipeline build uses Docker bundling (build logs show local esbuild bundling only).
7. A semantic query with no keyword overlap (e.g. "hot and hearty poultry dish" after seeding a spicy chicken stew) returns that recipe with `similarity > 0.15`, and results are ordered by `similarity` descending.
8. The search Lambda's synthesized IAM policy contains exactly `dynamodb:SearchVectors` for DynamoDB and `bedrock:InvokeModel` for Bedrock.
9. Requests without `x-api-key` are rejected with 403 by the gateway; requests with the key succeed.
10. A 4,000-character search query is rejected with 400 at the gateway (never reaches Bedrock).
11. `PUT` on a nonexistent recipe returns 404 via the conditional write (verify no `GetItem` appears in the update handler).
12. `GET /recipes/{id}` responses never contain an `embedding` field.
13. Changing `dimensions` in the `VectorIndex` props without renaming the index fails deployment with the explicit immutability error; renaming the index deploys a replacement successfully.
14. The Bruno collection opens in Bruno without errors; with a seeded Dev environment configured, running the six happy-path requests top to bottom passes every assert (including embedding absence on Get and result ordering on Search), and each request in `errors/` returns its expected status (400/404/400/403).
15. `cdk destroy -c sandbox=<name>` tears a sandbox down cleanly with no orphaned resources.

## 17. Addendum: listing and pagination (2026-08-24)

Added after initial delivery, superseding the original "no pagination of search results" non-goal:

- `GET /recipes` (list-recipes function) returns a cursor-paginated, name-ordered list backed by a sparse GSI `RecipeListIndex` (partition key `entityType` = `"RECIPE"`, sort key `name`, projection INCLUDE of all public attributes, never the embedding). IAM: exactly `dynamodb:Query` on the index ARN. Items written before the index existed lack `entityType` and stay invisible until re-written.
- `POST /recipes/search` accepts an optional `cursor`; `topK` (1-25, default 5) is the page size. `SearchVectors` has no native pagination (`TopK` cap 100), so each page fetches the full 100-candidate pool and slices at the cursor offset. Cursors carry a fingerprint binding them to their exact query and cuisine; mismatches return 400. Paging beyond 100 candidates is not possible.
- Cursors are opaque base64url JSON, validated structurally server-side. Gateway request validators do not check query-parameter ranges, so the list handler rejects out-of-contract `pageSize` with 400 rather than clamping.
