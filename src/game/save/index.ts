export { SaveManager, type SaveManagerOptions } from "./SaveManager";
export type { Saveable } from "./Saveable";
export { migrateTo } from "./Saveable";
export {
  ENVELOPE_VERSION,
  SLOT_IDS,
  MANUAL_SLOT_IDS,
  SaveEnvelopeSchema,
  slotKey,
  type SaveEnvelope,
  type SlotId,
  type SystemBlock,
} from "./envelope";
export type { SaveStore } from "./store/SaveStore";
export { IDBSaveStore } from "./store/IDBSaveStore";
export { getOrCreatePlayerId, uuid } from "./playerId";
export { PlaytimeTracker } from "./playtime";
