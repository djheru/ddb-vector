import type { AppSyncResolverEvent, AppSyncResolverHandler } from "aws-lambda";
import { createRecipe } from "../create-recipe/core";
import { deleteRecipe } from "../delete-recipe/core";
import { getRecipe } from "../get-recipe/core";
import { listRecipes } from "../list-recipes/core";
import { searchRecipes } from "../search-recipes/core";
import { internalErrorEnvelope, toEnvelope } from "../shared/appsync";
import type { ResolverEnvelope } from "../shared/appsync";
import { logError } from "../shared/http";
import { updateRecipe } from "../update-recipe/core";

/**
 * Lambdalith data source for the AppSync API: every query and mutation routes
 * through this one function, which looks up the resolver for the field being
 * resolved. Registry keys are `ParentType.fieldName` so a Query and a Mutation
 * can never collide.
 */
type ResolverArgs = Record<string, unknown>;
type Resolver = (args: ResolverArgs) => Promise<ResolverEnvelope<unknown>>;

/** GraphQL delivers omitted optional arguments as null; cores expect undefined. */
const optional = (value: unknown): unknown => value ?? undefined;

const registry = new Map<string, Resolver>([
  ["Query.getRecipe", async (args) => toEnvelope(await getRecipe(args.recipeId))],
  [
    "Query.listRecipes",
    async (args) =>
      toEnvelope(
        await listRecipes({ pageSize: optional(args.pageSize), cursor: optional(args.cursor) }),
      ),
  ],
  [
    "Query.searchRecipes",
    async (args) =>
      toEnvelope(
        await searchRecipes({
          query: args.query,
          cuisine: optional(args.cuisine),
          topK: optional(args.topK),
          cursor: optional(args.cursor),
        }),
      ),
  ],
  ["Mutation.createRecipe", async (args) => toEnvelope(await createRecipe(args.input))],
  [
    "Mutation.updateRecipe",
    async (args) => toEnvelope(await updateRecipe(args.recipeId, args.input)),
  ],
  ["Mutation.deleteRecipe", async (args) => toEnvelope(await deleteRecipe(args.recipeId))],
]);

export const handler: AppSyncResolverHandler<ResolverArgs, ResolverEnvelope<unknown>> = async (
  event: AppSyncResolverEvent<ResolverArgs>,
) => {
  const field = `${event.info.parentTypeName}.${event.info.fieldName}`;
  try {
    const resolver = registry.get(field);
    // A missing registry entry is a schema/registry mismatch: a config bug,
    // logged in full but surfaced to the client as a generic internal error.
    if (!resolver) throw new Error(`No resolver registered for field ${field}`);
    return await resolver(event.arguments ?? {});
  } catch (error) {
    logError("appsync resolver failed", error, { field });
    return internalErrorEnvelope();
  }
};
