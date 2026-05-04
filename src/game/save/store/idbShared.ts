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

/**
 * Without an `onversionchange` handler, calling
 * `indexedDB.deleteDatabase('sailing-rpg-saves')` from the devtools console
 * leaves the page's cached connection open, blocking the delete and deadlocking
 * subsequent reads. Closing the connection on `versionchange` lets the delete
 * complete; the next IDB op through idb-keyval's cached (now-closed) handle
 * throws InvalidStateError, which the save layer's try/catch turns into a
 * clean "no save" outcome.
 */
let versionChangeHookInstalled = false;
void kvStore("readonly", (store) => {
  if (!versionChangeHookInstalled) {
    versionChangeHookInstalled = true;
    const db = store.transaction.db;
    db.onversionchange = () => db.close();
  }
  return undefined;
}).catch(() => {});
