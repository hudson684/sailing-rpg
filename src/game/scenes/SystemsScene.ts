import * as Phaser from "phaser";
import { worldTicker } from "../entities/WorldTicker";
import { stamina } from "../player/stamina";
import { foodRegen } from "../player/foodRegen";
import { getActiveSaveController } from "../save/activeController";
import { useTimeStore } from "../time/timeStore";

/** Always-running scene that drives globally-scoped per-frame systems: the
 *  entity-model ticker, food-based HP regen, stamina regen, and playtime
 *  accumulation. Persists across World ↔ Interior swaps so these ticks never
 *  drift with the awake scene. Does not render anything. */
export class SystemsScene extends Phaser.Scene {
  constructor() {
    super({ key: "Systems", active: false, visible: false });
  }

  update(_time: number, dtMs: number) {
    worldTicker.tick(dtMs);
    foodRegen.tick(dtMs);
    stamina.regen(dtMs / 1000);
    useTimeStore.getState().tick(dtMs);
    getActiveSaveController()?.playtime.tick();
  }
}
