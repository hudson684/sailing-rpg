import { get, set, del, keys } from "idb-keyval";
import { SaveEnvelopeSchema, isSlotKey, type SaveEnvelope } from "../envelope";
import { kvStore } from "./idbShared";
import type { SaveStore } from "./SaveStore";

const TEMP_SUFFIX = ":tmp";

export class IDBSaveStore implements SaveStore {
  private readonly store = kvStore;

  async get(key: string): Promise<SaveEnvelope | null> {
    const raw = await get(key, this.store);
    if (raw == null) return null;
    const parsed = SaveEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[save] corrupt envelope at '${key}':`, parsed.error.issues);
      return null;
    }
    return parsed.data;
  }

  /**
   * Atomic-ish write: stage to a temp key, verify readback, then swap to the
   * real key. A crash mid-write can leave a temp key behind but never
   * corrupts an existing slot.
   */
  async put(key: string, envelope: SaveEnvelope): Promise<void> {
    const tmp = `${key}${TEMP_SUFFIX}`;
    await set(tmp, envelope, this.store);
    const readback = await get(tmp, this.store);
    const parsed = SaveEnvelopeSchema.safeParse(readback);
    if (!parsed.success) {
      await del(tmp, this.store).catch(() => {});
      console.warn(`[save] verification failed for '${key}':`, parsed.error.issues);
      throw new Error(`Save verification failed for '${key}'`);
    }
    await set(key, parsed.data, this.store);
    await del(tmp, this.store).catch(() => {});
  }

  async list(): Promise<SaveEnvelope[]> {
    const allKeys = (await keys(this.store)) as string[];
    const envelopes: SaveEnvelope[] = [];
    for (const k of allKeys) {
      if (!isSlotKey(k)) continue;
      const env = await this.get(k);
      if (env) envelopes.push(env);
    }
    return envelopes;
  }

  async delete(key: string): Promise<void> {
    await del(key, this.store);
  }
}
