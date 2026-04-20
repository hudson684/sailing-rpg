export { SaveManager, type SaveManagerOptions } from "./SaveManager";
export { SaveController, pickLatestEnvelope } from "./SaveController";
export { SceneState, type SceneMode } from "./sceneState";
export type { Saveable } from "./Saveable";
export { migrateTo } from "./Saveable";
export * as systems from "./systems";
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
