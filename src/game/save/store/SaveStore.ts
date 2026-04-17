import type { SaveEnvelope } from "../envelope";

/**
 * Abstract persistence layer. IDBSaveStore today; RemoteSaveStore (HTTP) later;
 * a SyncedSaveStore can compose both with last-write-wins on updatedAt.
 * Game code only sees this interface.
 */
export interface SaveStore {
  get(key: string): Promise<SaveEnvelope | null>;
  put(key: string, envelope: SaveEnvelope): Promise<void>;
  list(): Promise<SaveEnvelope[]>;
  delete(key: string): Promise<void>;
}
