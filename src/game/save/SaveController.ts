import { bus, type SaveRequest } from "../bus";
import { showToast } from "../../ui/store/ui";
import { SaveManager, type SaveManagerOptions } from "./SaveManager";
import { IDBSaveStore } from "./store/IDBSaveStore";
import type { SaveStore } from "./store/SaveStore";
import { getOrCreatePlayerId } from "./playerId";
import { PlaytimeTracker } from "./playtime";
import { SLOT_IDS, slotKey, type SaveEnvelope, type SlotId } from "./envelope";
import type { Saveable } from "./Saveable";

/**
 * Read all slots from `store` and return the most recently updated envelope,
 * or null if no saves exist. Used both by `SaveController.loadLatest()` and
 * by the preload screen to prefetch the save before the world scene starts.
 */
export async function pickLatestEnvelope(
  store: SaveStore,
): Promise<SaveEnvelope | null> {
  const envelopes = await Promise.all(
    SLOT_IDS.map((slot) => store.get(slotKey(slot))),
  );
  let latest: SaveEnvelope | null = null;
  for (const env of envelopes) {
    if (!env) continue;
    if (!latest || env.updatedAt > latest.updatedAt) latest = env;
  }
  return latest;
}

const GAME_VERSION = "0.0.1";
const AUTOSAVE_INTERVAL_MS = 10_000;

export interface SaveControllerOptions {
  getSceneKey: () => string;
  /** Apply a freshly loaded envelope to the scene (or a fresh-start envelope=null). */
  onApplied: (env: SaveEnvelope | null) => void;
  /** Optional gate for interval autosaves — return false to skip this tick (e.g. mid-animation). */
  canAutosave?: () => boolean;
}

/**
 * Owns the persistence side of the game: SaveManager + PlaytimeTracker + the
 * pause menu's slot list. Handles `save:request` events from the UI and emits
 * `pause:update` so the menu can render slot metadata without knowing anything
 * about IDB.
 *
 * Systems (Inventory, Ship, Player, GroundItems, SceneState) are registered
 * via `registerSystems()` after the scene wires them up.
 */
export class SaveController {
  readonly store = new IDBSaveStore();
  readonly playtime = new PlaytimeTracker();
  private manager: SaveManager | null = null;
  private playerId = "";
  private menuVisible = false;
  private readonly opts: SaveControllerOptions;
  private initialized = false;
  private autosaveHandle: number | null = null;

  constructor(opts: SaveControllerOptions) {
    this.opts = opts;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.playerId = await getOrCreatePlayerId();
    await this.playtime.start();
    const managerOpts: SaveManagerOptions = {
      store: this.store,
      playerId: this.playerId,
      gameVersion: GAME_VERSION,
      getSceneKey: this.opts.getSceneKey,
      getPlaytimeMs: () => this.playtime.ms,
      onChange: () => void this.refreshMenu(),
    };
    this.manager = new SaveManager(managerOpts);
    bus.onTyped("save:request", this.onRequest);
    bus.onTyped("pause:toggle", this.onToggle);
    this.autosaveHandle = window.setInterval(() => void this.tickAutosave(), AUTOSAVE_INTERVAL_MS);
    this.initialized = true;
  }

  shutdown(): void {
    bus.offTyped("save:request", this.onRequest);
    bus.offTyped("pause:toggle", this.onToggle);
    if (this.autosaveHandle != null) window.clearInterval(this.autosaveHandle);
    this.autosaveHandle = null;
    void this.playtime.stop();
  }

  private async tickAutosave(): Promise<void> {
    if (!this.manager) return;
    if (this.opts.canAutosave && !this.opts.canAutosave()) return;
    await this.manager.save("autosave");
  }

  registerSystems(systems: readonly Saveable[]): void {
    if (!this.manager) throw new Error("SaveController.init() not called");
    for (const s of systems) this.manager.register(s);
  }

  async autoload(): Promise<SaveEnvelope | null> {
    if (!this.manager) return null;
    const env = await this.manager.load("autosave");
    if (env) this.opts.onApplied(env);
    return env;
  }

  async loadLatest(): Promise<SaveEnvelope | null> {
    if (!this.manager) return null;
    const latest = await pickLatestEnvelope(this.store);
    if (!latest) return null;
    const applied = await this.manager.load(latest.slot);
    if (applied) this.opts.onApplied(applied);
    return applied;
  }

  /**
   * Hydrate from an envelope that was already fetched from IDB (e.g. prefetched
   * during the preload screen). Skips the IDB read on the critical path so the
   * world hydrates the moment the player dismisses the title.
   */
  loadPrefetched(env: SaveEnvelope | null): void {
    if (!this.manager || !env) return;
    this.manager.hydrateFrom(env);
    this.opts.onApplied(env);
  }

  async autosave(): Promise<void> {
    if (!this.manager) return;
    await this.manager.save("autosave");
  }

  async save(slot: SlotId): Promise<void> {
    if (!this.manager) return;
    await this.manager.save(slot);
    const name = slot === "autosave" ? "Autosaved" : slot === "quicksave" ? "Quicksaved" : `Saved to ${slotLabel(slot)}`;
    showToast(`${name}.`, 1500);
  }

  async load(slot: SlotId): Promise<void> {
    if (!this.manager) return;
    const env = await this.manager.load(slot);
    if (!env) {
      showToast(`No save in ${slotLabel(slot)}.`, 1800);
      return;
    }
    this.opts.onApplied(env);
    showToast(`Loaded ${slotLabel(slot)}.`, 1500);
    this.setMenuVisible(false);
  }

  async deleteSlot(slot: SlotId): Promise<void> {
    if (!this.manager) return;
    await this.manager.delete(slot);
    showToast(`Deleted ${slotLabel(slot)}.`, 1500);
  }

  async newGame(): Promise<void> {
    this.opts.onApplied(null);
    showToast("New game.", 1500);
    this.setMenuVisible(false);
  }

  setMenuVisible(visible: boolean): void {
    if (this.menuVisible === visible) return;
    this.menuVisible = visible;
    void this.refreshMenu();
  }

  isMenuVisible(): boolean {
    return this.menuVisible;
  }

  async refreshMenu(): Promise<void> {
    if (!this.manager) return;
    const slots = await Promise.all(
      SLOT_IDS.map(async (slot) => ({
        slot,
        envelope: await this.store.get(slotKey(slot)),
      })),
    );
    bus.emitTyped("pause:update", { visible: this.menuVisible, slots });
  }

  private readonly onRequest = (req: SaveRequest): void => {
    if (req.type === "save") void this.save(req.slot);
    else if (req.type === "load") void this.load(req.slot);
    else if (req.type === "delete") void this.deleteSlot(req.slot);
    else if (req.type === "newGame") void this.newGame();
    else if (req.type === "refresh") void this.refreshMenu();
  };

  private readonly onToggle = (): void => {
    this.setMenuVisible(!this.menuVisible);
  };
}

function slotLabel(slot: SlotId): string {
  if (slot === "autosave") return "autosave";
  if (slot === "quicksave") return "quicksave";
  const n = slot.replace("slot", "");
  return `slot ${n}`;
}
