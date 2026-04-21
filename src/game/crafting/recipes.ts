import { createRegistry } from "../data/createRegistry";
import recipeData from "../data/recipes.json";
import type { RecipeDef, RecipesFile, StationKind } from "./types";

/**
 * Recipe registry. Recipes are authored in `src/game/data/recipes.json`; each
 * one is bound to a `skill` (which job trains from it) and a `station` (which
 * station kind runs it). To add a new crafting skill, author more recipes and
 * station defs — no code changes required for standard forge-style crafts.
 */

const RAW = (recipeData as unknown as RecipesFile).recipes;

export const recipes = createRegistry<RecipeDef>(RAW, { label: "recipe" });

/** All recipes that a given station kind can craft. Handy for the modal. */
export function recipesForStation(kind: StationKind): RecipeDef[] {
  return recipes.all().filter((r) => r.station === kind);
}
