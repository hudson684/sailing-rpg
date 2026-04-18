import { createStore } from "idb-keyval";

/**
 * idb-keyval creates exactly one object store per DB on first open and never
 * upgrades to add more. Everything save-related lives in a single store and
 * uses key prefixes (`save:*`, `meta:*`) to namespace instead.
 */
export const DB_NAME = "sailing-rpg-saves";
export const STORE_NAME = "kv";

export const kvStore = createStore(DB_NAME, STORE_NAME);
export const metaStore = kvStore;
